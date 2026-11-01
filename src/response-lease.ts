import { AsyncLocalStorage } from 'node:async_hooks';
import { createResponseWarmup, type ReadResponseWarmupOptions } from './response-warmup';
export type { ReadResponseWarmupOptions, ReadResponseWarmupTarget, ReadResponseWarmupContext } from './response-warmup';
import { registerRegionalDeadlineReporter } from './d1/regional-deadline';
import type { D1CacheProfile } from './d1/profile';
import { MAX_RESPONSE_LEASE_BYTES, responseLeaseKey } from './d1/regional';
import { isMutation, matchesPath, needsFreshness } from './d1/read-freshness-policy';
import { hasCacheBypass, hasFreshnessCookie, hasFreshnessGeneration, validFreshnessHeader } from './d1/request-freshness';

interface LeaseScope { deadline?: number; dataDeadline?: number }
const scope = new AsyncLocalStorage<LeaseScope>();
export function limitReadResponseDataUntil(deadline: number): void { const current = scope.getStore(); if (current) current.dataDeadline = Math.min(current.dataDeadline ?? Infinity, deadline); }
registerRegionalDeadlineReporter(limitReadResponseDataUntil);

export function limitReadResponseLeaseUntil(deadline: number | undefined): void {
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
const bypass = (request: Request, ignoreCacheControl: boolean): boolean => request.body !== null || ['range','if-match','if-unmodified-since','if-range'].some((name) => request.headers.has(name)) || (!ignoreCacheControl && hasCacheBypass(request));

function entityTags(value: string): string[] | null {
  const tags: string[] = [];
  let index = 0;
  const whitespace = () => { while (value[index] === ' ' || value[index] === '\t') index++; };
  whitespace();
  while (index < value.length) {
    if (value.slice(index, index + 2) === 'W/') index += 2;
    if (value[index++] !== '"') return null;
    const start = index;
    while (index < value.length && value[index] !== '"') {
      const code = value.charCodeAt(index++);
      if (code < 33 || code === 127 || code > 255) return null;
    }
    if (value[index] !== '"') return null;
    tags.push(value.slice(start, index++));
    whitespace();
    if (index === value.length) break;
    if (value[index++] !== ',') return null;
    whitespace();
    if (index === value.length) return null;
  }
  return tags.length ? tags : null;
}

function httpDate(value: string | null): number {
  if (!value || !/^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/.test(value)) return NaN;
  const time = Date.parse(value.endsWith(' GMT') ? value : `${value} GMT`);
  if (!Number.isFinite(time)) return NaN;
  const date = new Date(time);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = days[date.getUTCDay()];
  const month = months[date.getUTCMonth()];
  const number = String(date.getUTCDate()).padStart(2, '0');
  const clock = date.toUTCString().slice(17, 25);
  const rfc850 = `${day}, ${number}-${month}-${String(date.getUTCFullYear() % 100).padStart(2, '0')} ${clock} GMT`;
  const asctime = `${day?.slice(0, 3)} ${month} ${String(date.getUTCDate()).padStart(2, ' ')} ${clock} ${date.getUTCFullYear()}`;
  return value === date.toUTCString() || value === rfc850 || value === asctime ? time : NaN;
}

function conditionalHit(request: Request, response: Response): Response {
  const condition = request.headers.get('if-none-match');
  let matches = false;
  if (condition !== null) {
    if (condition.trim() === '*') matches = true;
    else {
      const requested = entityTags(condition);
      const current = entityTags(response.headers.get('etag') ?? '');
      matches = !!requested && !!current && current.length === 1 && requested.includes(current[0] ?? '');
    }
  } else {
    const modified = httpDate(response.headers.get('last-modified'));
    const since = httpDate(request.headers.get('if-modified-since'));
    matches = Number.isFinite(modified) && Number.isFinite(since) && modified <= since;
  }
  if (!matches) return response;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  void response.body?.cancel().catch(() => undefined);
  return new Response(null, { status:304, headers });
}

function selectedCookies(header: string | null, names: readonly string[]): string | null {
  const selected = (header ?? '').split(';').map((part) => part.trimStart()).filter((part) => {
    const separator = part.indexOf('=');
    return separator > 0 && names.includes(part.slice(0, separator).trim());
  });
  return selected.length ? selected.join(';') : null;
}

function withoutCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  const value = header.split(';').filter((part) => {
    const separator = part.indexOf('=');
    return separator < 0 || part.slice(0, separator).trim() !== name;
  }).join(';').trim();
  return value || null;
}

const metadataHeader = 'x-dee-wan-lease-meta';

async function readLease(key: string, ttl: number, permittedVary: Set<string>): Promise<{ response: Response; expires: number } | null> {
  let cached: Response | undefined;
  let transferred = false;
  try {
    cached = await caches.default.match(key);
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
    const response = new Response(cached.body, { status:cached.status, statusText:cached.statusText, headers });
    transferred = true;
    return { response, expires };
  } catch { return null; }
  finally { if (cached && !transferred) void cached.body?.cancel().catch(() => undefined); }
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

export type ReadResponseLeasePolicy = Omit<NonNullable<D1CacheProfile['readResponseLease']>, 'databaseBinding' | 'deploymentEnv'>;
export interface ReadResponseLeaseOptions extends ReadResponseLeasePolicy {
  namespace: string;
  deployment: string;
  database: string;
  seconds: number;
  warmup?: ReadResponseWarmupOptions;
}
type LeaseConfig = (NonNullable<D1CacheProfile['readResponseLease']> | ReadResponseLeaseOptions) & { warmup?: ReadResponseWarmupOptions };
interface ResolvedLease { config: LeaseConfig; seconds: number; identity: () => unknown[] | null }
export function createReadResponseLease<Env, Context>(handler: (request: Request, env: Env, context: Context) => Promise<Response>, resolve: (env: Env) => ResolvedLease | null): (request: Request, env: Env, context: Context) => Promise<Response> {
  const pending = new Map<string, { valid: boolean; task: Promise<void> }>();
  let foreground = 0;
  const warming = createResponseWarmup<Env, Context>((request, env, context) => wrapped(request, env, context), () => foreground === 0);
  const wrapped = async (request: Request, env: Env, context: Context): Promise<Response> => {
    const requestStarted = Date.now();
    const requestGeneration = warming.snapshot();
    const serve = async (input: Request): Promise<Response> => {
      if (input.method !== 'GET' || warming.isInternal(request)) return handler(input, env, context);
      foreground++;
      try { return await handler(input, env, context); }
      finally { foreground--; }
    };
    const resolved = resolve(env);
    if (!resolved) return serve(request);
    const { config, seconds } = resolved;
    const maxSeconds = config.maxSeconds ?? 5;
    const refreshAhead = config.refreshAheadSeconds ?? 0;
    if (!Number.isInteger(refreshAhead) || refreshAhead < 0 || refreshAhead > maxSeconds || !Number.isInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 300 || !Number.isInteger(seconds) || seconds <= 0 || seconds > maxSeconds || !/^[A-Za-z0-9_-]+$/.test(config.freshnessCookie)) return serve(request);
    if (config.cookieNames !== undefined && (!Array.isArray(config.cookieNames) || config.cookieNames.length === 0 || !config.cookieNames.every((name) => typeof name === 'string' && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) || new Set(config.cookieNames).size !== config.cookieNames.length || !config.credentialHeaders.some((name) => name.toLowerCase() === 'cookie') || (config.freshnessCookieMode === 'generation' && !config.cookieNames.includes(config.freshnessCookie)))) return serve(request);
    const generationMode = config.freshnessCookieMode === 'generation' && config.credentialHeaders.some((name) => name.toLowerCase() === 'cookie');
    if (isMutation(request.method)) {
      const response = await handler(request, env, context);
      if (response.status < 200 || response.status >= 300 || !needsFreshness(request.method, new URL(request.url).pathname, config.freshnessCookieExcludedPaths)) return response;
      warming.invalidate();
      const headers = new Headers(response.headers);
      headers.append('set-cookie', `${config.freshnessCookie}=${generationMode ? crypto.randomUUID() : '1'}; Max-Age=${maxSeconds}; Path=/; HttpOnly; SameSite=Lax${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`);
      return new Response(response.body, { status:response.status, statusText:response.statusText, headers });
    }
    if (request.method !== 'GET') return serve(request);
    if (hasFreshnessCookie(request, config.freshnessCookie) && (!generationMode || !hasFreshnessGeneration(request, config.freshnessCookie))) return serve(noCache(request));
    if (config.freshnessHeader !== undefined && !validFreshnessHeader(config.freshnessHeader)) return serve(noCache(request));
    const forceSource = config.freshnessHeader !== undefined && request.headers.has(config.freshnessHeader);
    const url = new URL(request.url);
    const headerValue = (name: string): string | null => name.toLowerCase() === 'cookie' && config.cookieNames !== undefined ? selectedCookies(request.headers.get('cookie'), config.cookieNames) : request.headers.get(name);
    const hasCredential = (name: string): boolean => {
      const value = headerValue(name);
      if (name.toLowerCase() !== 'cookie' || config.cookieNames === undefined) return !!value?.trim();
      return (value ?? '').split(';').some((pair) => { const separator = pair.indexOf('='); return separator > 0 && pair.slice(0, separator).trim() !== config.freshnessCookie && !!pair.slice(separator + 1).trim(); });
    };
    if (bypass(request, config.ignoreRequestCacheControl === true) || !matchesPath(url.pathname, config.paths) || config.bypassQueryParams?.some((name) => url.searchParams.has(name)) || !config.credentialHeaders.some(hasCredential)) return serve(forceSource ? noCache(request) : request);
    const identity = resolved.identity();
    if (!identity) return serve(noCache(request));
    const names = [...new Set([...config.credentialHeaders, ...config.varyHeaders].map((name) => name.toLowerCase()))].sort();
    const permittedVary = new Set(names);
    const ttl = seconds * 1000;
    const key = await responseLeaseKey(ttl, [identity[0], request.method, request.url, ...identity.slice(1), names.map((name) => [name, headerValue(name)])]);
    if (!key) return serve(noCache(request));
    const cached = forceSource ? null : await readLease(key, ttl, permittedVary);
    const warmOptions = config.warmup;
    const warmGroup = warmOptions && typeof warmOptions.scopeHeader === 'string' && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(warmOptions.scopeHeader) && config.varyHeaders.some((name) => name.toLowerCase() === warmOptions.scopeHeader.toLowerCase()) ? await responseLeaseKey(ttl, ['response-warmup-group', identity, names.map((name) => [name, headerValue(name)]), request.headers.get(warmOptions.scopeHeader)]) : null;
    const credentialGroup = warmOptions?.catalogScope === 'credential' && warmGroup && !config.credentialHeaders.some((name) => name.toLowerCase() === warmOptions.scopeHeader.toLowerCase()) ? await responseLeaseKey(ttl, ['response-warmup-credential-group', identity, names.filter((name) => name !== warmOptions.scopeHeader.toLowerCase()).map((name) => [name, name === 'cookie' ? withoutCookie(headerValue(name), config.freshnessCookie) : headerValue(name)])]) : null;
    const eligible = (target: URL) => matchesPath(target.pathname, config.paths) && !config.bypassQueryParams?.some((name) => target.searchParams.has(name));
    const scheduleWarm = (response: Response) => {
      let transferred = false;
      try {
        if (!warmOptions || !warmGroup || warming.isInternal(request) || !warming.current(requestGeneration)) return;
        const wait: unknown = context && typeof context === 'object' ? Reflect.get(context, 'waitUntil') : undefined;
        if (typeof wait !== 'function') return;
        const task = warming.start(warmOptions, request, response, identity, warmGroup, eligible, env, context, config.freshnessHeader, credentialGroup ?? undefined);
        transferred = true;
        Reflect.apply(wait, context, [task]);
      } catch { /* Warming is optional. */ }
      finally { if (!transferred) void response.body?.cancel().catch(() => undefined); }
    };
    const fillResponse = async (response: Response, lease: LeaseScope, started: number, allowed: () => boolean, beforePut?: Promise<void>) => {
      if (lease.deadline === undefined || !Number.isFinite(lease.deadline)) return;
      let warmResponse: Response | undefined;
      if (warmOptions && warmGroup && !warming.isInternal(request) && typeof waitUntil === 'function') {
        try { warmResponse = response.clone(); } catch { /* Warming is optional. */ }
      }
      const expires = Math.floor(Math.min(started + ttl, lease.deadline, lease.dataDeadline ?? Infinity));
      try {
        const entry = await responseEntry(response, permittedVary);
        if (entry && beforePut) await beforePut;
        if (entry && Number.isSafeInteger(expires) && expires > Date.now() && allowed() && warming.current(requestGeneration) && warming.allowed(request)) {
          warming.verify(request);
          if (warmResponse) { const owned = warmResponse; warmResponse = undefined; scheduleWarm(owned); }
          const headers = new Headers(response.headers);
          headers.set(metadataHeader, JSON.stringify([Math.floor(started), expires, headers.get('cache-control')]));
          headers.set('cache-control', 'public, max-age=300');
          await caches.default.put(key, new Response(entry, { status:response.status, statusText:response.statusText, headers }));
        }
      } catch { /* Cache filling must not affect the source response. */ }
      finally { if (warmResponse) void warmResponse.body?.cancel().catch(() => undefined); }
    };
    const waitUntil: unknown = context && typeof context === 'object' ? Reflect.get(context, 'waitUntil') : undefined;
    if (cached) {
      warming.verify(request);
      if (warmOptions && warmGroup && !warming.isInternal(request) && typeof waitUntil === 'function') {
        try { scheduleWarm(cached.response.clone()); } catch { /* Warming is optional. */ }
      }
      if (refreshAhead > 0 && refreshAhead <= seconds && cached.expires - Date.now() <= refreshAhead * 1000 && typeof waitUntil === 'function' && !pending.has(key)) {
        const refresh = { valid:true, task:Promise.resolve() };
        let accepted = false;
        refresh.task = Promise.resolve().then(async () => {
          if (!accepted) return;
          const started = Date.now();
          const headers = new Headers(request.headers);
          for (const name of ['range', 'if-match', 'if-unmodified-since', 'if-range', 'if-none-match', 'if-modified-since']) headers.delete(name);
          headers.set('cache-control', 'no-cache');
          if (config.freshnessHeader !== undefined) headers.set(config.freshnessHeader, '1');
          const source = new Request(request.url, { method:'GET', headers, signal:new AbortController().signal });
          const lease: LeaseScope = {};
          try {
            const response = await scope.run(lease, () => handler(source, env, context));
            try { await fillResponse(response, lease, started, () => refresh.valid); }
            finally { void response.body?.cancel().catch(() => undefined); }
          } catch { /* Refresh failures leave the old lease untouched. */ }
        }).finally(() => { if (pending.get(key) === refresh) pending.delete(key); });
        pending.set(key, refresh);
        try { Reflect.apply(waitUntil, context, [refresh.task]); accepted = true; } catch { pending.delete(key); }
      }
      return conditionalHit(request, cached.response);
    }
    const priorRefresh = pending.get(key);
    if (priorRefresh) priorRefresh.valid = false;
    const lease: LeaseScope = {};
    const source = noCache(request);
    if (config.freshnessHeader !== undefined) source.headers.set(config.freshnessHeader, '1');
    const response = await scope.run(lease, () => serve(source));
    const fill = fillResponse(response, lease, requestStarted, () => true, priorRefresh?.task);
    try {
      if (!warming.isInternal(request) && typeof waitUntil === 'function') { Reflect.apply(waitUntil, context, [fill]); return response; }
    } catch { /* Await the fill if the request context is unavailable. */ }
    await fill;
    return response;
  };
  return wrapped;
}

export function wrapReadResponseLease<Env, Context>(handler: (request: Request, env: Env, context: Context) => Promise<Response>, options: ReadResponseLeaseOptions): (request: Request, env: Env, context: Context) => Promise<Response> {
  return createReadResponseLease(handler, () => {
    if (![options.namespace, options.deployment, options.database].every((value) => typeof value === 'string' && value.trim().length > 0)) return null;
    const { warmup: _warmup, ...identity } = options;
    return { config: options, seconds: options.seconds, identity: () => ['response-lease-v1', identity] };
  });
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

export function wrapReadResponseLeaseOrigin<Env, Context>(handler: (request: Request, env: Env, context: Context) => Promise<Response>): (request: Request, env: Env, context: Context) => Promise<Response> {
  return async (request, env, context) => {
    const lease: LeaseScope = {};
    const response = await scope.run(lease, () => handler(withoutProof(request), env, context));
    const deadline = lease.deadline;
    const type = response.headers.get('content-type') ?? '';
    if (request.method !== 'GET' || response.status !== 200 || response.headers.has('set-cookie') || !/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(type) || deadline === undefined || !Number.isFinite(deadline) || deadline <= Date.now()) return responseWithProof(response);
    return responseWithProof(response, Math.min(deadline, lease.dataDeadline ?? Infinity));
  };
}

export async function forwardReadLease(request: Request, service: { fetch(request: Request): Promise<Response> }): Promise<Response> {
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
    if (Number.isSafeInteger(deadline) && deadline > Date.now()) limitReadResponseLeaseUntil(deadline);
  }
  return responseWithProof(response);
}
