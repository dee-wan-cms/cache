import { AsyncLocalStorage } from 'node:async_hooks';
import { d1CacheRuntime } from './env';
import { isD1BindingName, type D1CacheProfile } from './profile';
import { MAX_RESPONSE_LEASE_BYTES, responseLeaseKey } from './regional';
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

const metadataHeader = 'x-dee-wan-lease-meta';

async function readLease(key: string, ttl: number, permittedVary: Set<string>): Promise<Response | null> {
  try {
    const cached = await caches.default.match(key);
    if (!cached || cached.status !== 200 || !eligibleHeaders(cached.headers, permittedVary)) return null;
    const metadata = cached.headers.get(metadataHeader);
    if (!metadata) return null;
    const parsed: unknown = JSON.parse(metadata);
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [started, expires, control] = parsed;
    const now = Date.now();
    if (!Number.isSafeInteger(started) || !Number.isSafeInteger(expires) || started > now || expires <= now || expires > started + ttl || (control !== null && typeof control !== 'string')) return null;
    const headers = new Headers(cached.headers);
    headers.delete(metadataHeader);
    if (control === null) headers.delete('cache-control');
    else headers.set('cache-control', control);
    return new Response(cached.body, { status:cached.status, statusText:cached.statusText, headers });
  } catch { return null; }
}

function eligibleHeaders(headers: Headers, permittedVary: Set<string>): boolean {
  if (headers.has('set-cookie') || headers.has('content-encoding') || headers.has('content-disposition') || !/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(headers.get('content-type') ?? '')) return false;
  const vary = headers.get('vary');
  return !vary || vary.split(',').every((name) => permittedVary.has(name.trim().toLowerCase()));
}

async function responseEntry(response: Response, permittedVary: Set<string>): Promise<Uint8Array | null> {
  if (response.status !== 200 || response.headers.has(metadataHeader) || !eligibleHeaders(response.headers, permittedVary)) return null;
  const reader = response.clone().body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('body timeout')), 5000); });
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
    return bytes;
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
    const key = await responseLeaseKey(ttl, ['d1-response-lease-v2', request.method, request.url, profile, release, identities, names.map((name) => [name, request.headers.get(name)])]);
    if (!key) return handler(noCache(request), env, context);
    const cached = await readLease(key, ttl, permittedVary);
    if (cached) return cached;
    const started = requestStarted;
    const lease: LeaseScope = {};
    const source = noCache(request);
    if (config.freshnessHeader !== undefined) source.headers.set(config.freshnessHeader, '1');
    const response = await scope.run(lease, () => handler(source, env, context));
    if (lease.deadline === undefined || !Number.isFinite(lease.deadline)) return response;
    const fillTtl = Math.min(ttl, lease.deadline - started, (lease.dataDeadline ?? Infinity) - started);
    const fill = (async () => {
      try {
        const entry = await responseEntry(response, permittedVary);
        const expires = Math.floor(started + fillTtl);
        if (entry && Number.isSafeInteger(expires) && expires > Date.now()) {
          const headers = new Headers(response.headers);
          headers.set(metadataHeader, JSON.stringify([Math.floor(started), expires, headers.get('cache-control')]));
          headers.set('cache-control', 'public, max-age=300');
          await caches.default.put(key, new Response(entry, { status:response.status, statusText:response.statusText, headers }));
        }
      } catch { /* Cache filling must not affect the source response. */ }
    })();
    try {
      const waitUntil: unknown = context && typeof context === 'object' ? Reflect.get(context, 'waitUntil') : undefined;
      if (typeof waitUntil === 'function') { Reflect.apply(waitUntil, context, [fill]); return response; }
    } catch { /* Await the fill if the request context is unavailable. */ }
    await fill;
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
  let forwarded = withoutProof(request);
  if (request.method === 'GET') {
    const headers = new Headers(forwarded.headers);
    headers.set('accept-encoding', 'identity');
    forwarded = new Request(forwarded, { headers });
  }
  const response = await service.fetch(forwarded);
  const raw = response.headers.get(proofHeader);
  if (raw && /^\d+$/.test(raw)) {
    const deadline = Number(raw);
    if (Number.isSafeInteger(deadline) && deadline > Date.now()) limitD1ReadLeaseUntil(deadline);
  }
  return responseWithProof(response);
}
