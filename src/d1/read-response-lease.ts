import { AsyncLocalStorage } from 'node:async_hooks';
import { d1CacheRuntime } from './env';
import { isD1BindingName, type D1CacheProfile } from './profile';
import { MAX_RESPONSE_LEASE_BYTES, responseLeaseKey, responseLeaseRead, responseLeaseWrite } from './regional';
import { isMutation, matchesPath, needsFreshness } from './read-freshness-policy';
import { hasCacheBypass, hasFreshnessCookie, hasFreshnessGeneration, validFreshnessHeader } from './request-freshness';
import { registerRegionalDeadlineReporter } from './regional-deadline';

interface LeaseScope { deadline?: number; dataDeadline?: number }
const scope = new AsyncLocalStorage<LeaseScope>();
registerRegionalDeadlineReporter((deadline) => { const current = scope.getStore(); if (current) current.dataDeadline = Math.min(current.dataDeadline ?? Infinity, deadline); });

export function limitD1ReadLeaseUntil(deadline: number | undefined): void {
  const current = scope.getStore();
  if (!current) return;
  if (deadline === undefined || !Number.isFinite(deadline)) { current.deadline = 0; return; }
  current.deadline = Math.min(current.deadline ?? Infinity, deadline);
}

const noCache = (request: Request): Request => {
  const headers = new Headers(request.headers);
  headers.set('cache-control', 'no-cache');
  return new Request(request, { headers });
};
const bypass = (request: Request, ignoreCacheControl: boolean): boolean => request.body !== null || ['range','if-match','if-none-match','if-modified-since','if-unmodified-since','if-range'].some((name) => request.headers.has(name)) || (!ignoreCacheControl && hasCacheBypass(request));

interface Entry { statusText: string; headers: [string, string][]; body: string }
function decodeEntry(value: unknown, permittedVary: Set<string>): Response | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Partial<Entry>;
  if (typeof entry.statusText !== 'string' || typeof entry.body !== 'string' || !Array.isArray(entry.headers) || !entry.headers.every((item) => Array.isArray(item) && item.length === 2 && typeof item[0] === 'string' && typeof item[1] === 'string')) return null;
  try {
    if (new TextEncoder().encode(entry.body).byteLength > MAX_RESPONSE_LEASE_BYTES) return null;
    JSON.parse(entry.body);
    const headers = new Headers(entry.headers);
    const length = headers.get('content-length');
    if (length !== null && (!/^(?:0|[1-9]\d*)$/.test(length) || Number(length) !== new TextEncoder().encode(entry.body).byteLength)) return null;
    if (!eligibleHeaders(headers, permittedVary)) return null;
    return new Response(entry.body, { status:200, statusText:entry.statusText, headers });
  } catch { return null; }
}

function eligibleHeaders(headers: Headers, permittedVary: Set<string>): boolean {
  if (headers.has('set-cookie') || headers.has('content-encoding') || headers.has('content-disposition') || !/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(headers.get('content-type') ?? '')) return false;
  const vary = headers.get('vary');
  return !vary || vary.split(',').every((name) => permittedVary.has(name.trim().toLowerCase()));
}

async function responseEntry(response: Response, permittedVary: Set<string>): Promise<Entry | null> {
  if (response.status !== 200 || !eligibleHeaders(response.headers, permittedVary)) return null;
  const reader = response.clone().body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('body timeout')), 1000); });
    for (;;) {
      const part = await Promise.race([reader.read(), timeout]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_LEASE_BYTES) return null;
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body = new TextDecoder('utf-8', { fatal:true, ignoreBOM:false }).decode(bytes);
    JSON.parse(body);
    const length = response.headers.get('content-length');
    if (length !== null && (!/^(?:0|[1-9]\d*)$/.test(length) || Number(length) !== size)) return null;
    return { body, statusText:response.statusText, headers:[...response.headers.entries()] };
  } catch { return null; }
  finally { if (timer !== undefined) clearTimeout(timer); void reader.cancel().catch(() => undefined); }
}

export function wrapD1ReadResponseLease<Env extends object, Context>(handler: (request: Request, env: Env, context: Context) => Promise<Response>, profile: D1CacheProfile): (request: Request, env: Env, context: Context) => Promise<Response> {
  return async (request, env, context) => {
    const requestStarted = Date.now();
    const config = profile.readResponseLease;
    const rawSeconds: unknown = Reflect.get(env, `${profile.envPrefix}_READ_ACCESS_SECONDS`);
    const maxSeconds = config?.maxSeconds ?? 5;
    const seconds = typeof rawSeconds === 'string' && /^(?:0|[1-9]\d{0,2})$/.test(rawSeconds) ? Number(rawSeconds) : 0;
    if (!config || !Number.isInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 300 || !seconds || seconds > maxSeconds || !/^[A-Za-z0-9_-]+$/.test(config.freshnessCookie)) return handler(request, env, context);
    const release: unknown = Reflect.get(env, config.deploymentEnv);
    const database: unknown = Reflect.get(env, config.databaseBinding);
    const runtime = database && typeof database === 'object' ? d1CacheRuntime(database) : undefined;
    if (!isD1BindingName(config.databaseBinding, profile) || typeof release !== 'string' || !release.trim() || !runtime?.readsEnabled || !runtime.regionalIdentity) return handler(request, env, context);
    const generationMode = config.freshnessCookieMode === 'generation' && config.credentialHeaders.some((name) => name.toLowerCase() === 'cookie');
    if (isMutation(request.method)) {
      const response = await handler(request, env, context);
      if (response.status < 200 || response.status >= 300 || !needsFreshness(request.method, new URL(request.url).pathname, config.freshnessCookieExcludedPaths)) return response;
      const headers = new Headers(response.headers);
      headers.append('set-cookie', `${config.freshnessCookie}=${generationMode ? crypto.randomUUID() : '1'}; Max-Age=${maxSeconds}; Path=/; HttpOnly; SameSite=Lax${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`);
      return new Response(response.body, { status:response.status, statusText:response.statusText, headers });
    }
    if (request.method !== 'GET') return handler(request, env, context);
    if (hasFreshnessCookie(request, config.freshnessCookie) && (!generationMode || !hasFreshnessGeneration(request, config.freshnessCookie))) return handler(noCache(request), env, context);
    if (config.freshnessHeader !== undefined && (!validFreshnessHeader(config.freshnessHeader) || request.headers.has(config.freshnessHeader))) return handler(noCache(request), env, context);
    const url = new URL(request.url);
    if (bypass(request, config.ignoreRequestCacheControl === true) || !matchesPath(url.pathname, config.paths) || config.bypassQueryParams?.some((name) => url.searchParams.has(name)) || !config.credentialHeaders.some((name) => !!request.headers.get(name)?.trim())) return handler(request, env, context);
    const identities: unknown[] = [];
    for (const [name, value] of Object.entries(env)) {
      if (!isD1BindingName(name, profile)) continue;
      const dependency = value && typeof value === 'object' ? d1CacheRuntime(value) : undefined;
      if (!dependency?.readsEnabled || !dependency.regionalIdentity) return handler(noCache(request), env, context);
      identities.push([name, dependency.databaseId, dependency.generation, dependency.coordinatorName, dependency.regionalIdentity]);
    }
    identities.sort((a, b) => String(a).localeCompare(String(b)));
    const names = [...new Set([...config.credentialHeaders, ...config.varyHeaders].map((name) => name.toLowerCase()))].sort();
    const permittedVary = new Set(names);
    const ttl = seconds * 1000;
    const key = await responseLeaseKey(ttl, ['d1-response-lease-v1', request.method, request.url, profile, release, identities, names.map((name) => [name, request.headers.get(name)])]);
    if (!key) return handler(noCache(request), env, context);
    const cached = await responseLeaseRead(key, ttl);
    if (cached) {
      const response = decodeEntry(cached.value, permittedVary);
      if (response) return response;
    }
    const started = requestStarted;
    const lease: LeaseScope = {};
    const response = await scope.run(lease, () => handler(noCache(request), env, context));
    if (lease.deadline === undefined || !Number.isFinite(lease.deadline)) return response;
    const entry = await responseEntry(response, permittedVary);
    if (entry) await responseLeaseWrite(key, Math.min(ttl, lease.deadline - started, (lease.dataDeadline ?? Infinity) - started), started, entry);
    return response;
  };
}

const proofHeader = 'x-dee-wan-read-lease-deadline';

function withoutProof(request: Request): Request {
  if (!request.headers.has(proofHeader)) return request;
  const headers = new Headers(request.headers);
  headers.delete(proofHeader);
  return new Request(request, { headers });
}

function responseWithProof(response: Response, deadline?: number): Response {
  if (!response.headers.has(proofHeader) && deadline === undefined) return response;
  const headers = new Headers(response.headers);
  headers.delete(proofHeader);
  if (deadline !== undefined) headers.set(proofHeader, String(Math.floor(deadline)));
  return new Response(response.body, { status:response.status, statusText:response.statusText, headers, ...(response.webSocket ? { webSocket:response.webSocket } : {}) });
}

export function wrapD1ReadLeaseOrigin<Env, Context>(handler: (request: Request, env: Env, context: Context) => Promise<Response>): (request: Request, env: Env, context: Context) => Promise<Response> {
  return async (request, env, context) => {
    const lease: LeaseScope = {};
    const response = await scope.run(lease, () => handler(withoutProof(request), env, context));
    const deadline = lease.deadline;
    const type = response.headers.get('content-type') ?? '';
    if (request.method !== 'GET' || response.status !== 200 || response.headers.has('set-cookie') || !/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(type) || deadline === undefined || !Number.isFinite(deadline) || deadline <= Date.now()) return responseWithProof(response);
    return responseWithProof(response, Math.min(deadline, lease.dataDeadline ?? Infinity));
  };
}

export async function forwardD1ReadLease(request: Request, service: { fetch(request: Request): Promise<Response> }): Promise<Response> {
  const response = await service.fetch(withoutProof(request));
  const raw = response.headers.get(proofHeader);
  if (raw && /^\d+$/.test(raw)) {
    const deadline = Number(raw);
    if (Number.isSafeInteger(deadline) && deadline > Date.now()) limitD1ReadLeaseUntil(deadline);
  }
  return responseWithProof(response);
}
