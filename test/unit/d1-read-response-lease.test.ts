import { afterEach, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import type { CacheStore } from '../../src/core/types';
import type { D1CacheProfile } from '../../src/d1/profile';
import { createD1CacheRuntime } from '../../src/d1/env';
import { cacheD1Read } from '../../src/d1/read';
import { regionalD1MetadataTtl } from '../../src/d1/request-freshness';
import { forwardD1ReadLease, limitD1ReadLeaseUntil, wrapD1ReadLeaseOrigin, wrapD1ReadResponseLease } from '../../src/d1/read-response-lease';

const entries = new Map<string, Response>();
const cache = { match:vi.fn(async (key: string) => entries.get(key)?.clone()), put:vi.fn(async (key: string, value: Response) => { entries.set(key, value.clone()); }) };
vi.stubGlobal('caches', { default:cache });
afterEach(() => { entries.clear(); vi.clearAllMocks(); vi.useRealTimers(); });
const profile: D1CacheProfile = { envPrefix:'TEST', bindingNames:['DB'], bindingPrefixes:['TENANT_'], coordinatorNamePrefix:'test:', coordinatorClass:'CacheCoordinator', readModels:[], unfencedWriteTables:[], readResponseLease:{ databaseBinding:'DB', deploymentEnv:'RELEASE', paths:['/metadata', '/items/*'], credentialHeaders:['cookie', 'cf-access-jwt-assertion'], varyHeaders:['x-site-id', 'origin', 'accept', 'accept-language'], bypassQueryParams:['q'], freshnessCookie:'fresh' } };
const unused = (): never => { throw Error('unused'); };
const binding: D1Database = { exec:unused, prepare:unused, batch:unused, withSession:unused, dump:unused };
const store: CacheStore = { beginWrite:async () => {}, endWrite:async () => {}, invalidate:async () => {}, read:unused, release:async () => {}, write:unused };
function fixture() {
  const db = createD1CacheRuntime(binding, { store, databaseId:'db', generation:'1', coordinatorName:'db', regionalIdentity:'coord', profile });
  const env = { DB:db, TEST_READ_ACCESS_SECONDS:'5', RELEASE:'release-1' };
  let calls = 0;
  const handler = vi.fn(async (request: Request) => {
    calls++;
    limitD1ReadLeaseUntil(Date.now() + 10000);
    return new Response(JSON.stringify({ calls, control:request.headers.get('cache-control') }), { headers:{ 'content-type':'application/json', 'cache-control':'private, no-store', vary:'Origin' } });
  });
  const wrapped = wrapD1ReadResponseLease(handler, profile);
  const req = (headers: Record<string,string> = {}, url = 'https://test.example/metadata', method = 'GET') => new Request(url, { method, headers:{ cookie:'session=a', origin:'https://site.example', ...headers } });
  return { env, handler, wrapped, req };
}

it('scopes warm reads by credentials, site, origin and release without calling the handler', async () => {
  const f = fixture();
  expect(await (await f.wrapped(f.req(), f.env, undefined)).json()).toHaveProperty('calls', 1);
  expect(await (await f.wrapped(f.req(), f.env, undefined)).json()).toHaveProperty('calls', 1);
  expect(f.handler).toHaveBeenCalledTimes(1);
  expect(await (await f.wrapped(f.req({ cookie:'session=b' }), f.env, undefined)).json()).toHaveProperty('calls', 2);
  expect(await (await f.wrapped(f.req({ 'x-site-id':'other' }), f.env, undefined)).json()).toHaveProperty('calls', 3);
  expect(await (await f.wrapped(f.req({ origin:'https://other.example' }), f.env, undefined)).json()).toHaveProperty('calls', 4);
  expect(await (await f.wrapped(f.req(), { ...f.env, RELEASE:'release-2' }, undefined)).json()).toHaveProperty('calls', 5);
  expect(await (await f.wrapped(f.req(), f.env, undefined)).json()).toHaveProperty('control', 'no-cache');
});

it('selects cookie credentials without collapsing duplicates or other credential headers', async () => {
  const f = fixture();
  const base = profile.readResponseLease;
  if (!base) throw Error('lease policy missing');
  const policy: D1CacheProfile = { ...profile, readResponseLease:{ ...base, credentialHeaders:['cookie', 'authorization'], cookieNames:['session', 'secure-session', 'access', 'fresh'] } };
  const wrapped = wrapD1ReadResponseLease(f.handler, policy);
  const read = (cookie: string, authorization = 'Bearer a') => wrapped(f.req({ cookie, authorization }), f.env, undefined);
  await read('session=a; nuisance=one');
  await read('session=a; nuisance=two');
  expect(f.handler).toHaveBeenCalledTimes(1);
  for (const [cookie, authorization] of [
    ['session=b', 'Bearer a'], ['secure-session=a', 'Bearer a'], ['access=a', 'Bearer a'], ['session=a; secure-session=b', 'Bearer a'],
    ['session=a; session=b', 'Bearer a'], ['session=b; session=a', 'Bearer a'], ['session=a', 'Bearer b'],
  ] as const) await read(cookie, authorization);
  expect(f.handler).toHaveBeenCalledTimes(8);
  await read('nuisance=one', ''); await read('nuisance=two', '');
  expect(f.handler).toHaveBeenCalledTimes(10);
  await f.wrapped(f.req({ cookie:'session=a; nuisance=one' }), f.env, undefined);
  await f.wrapped(f.req({ cookie:'session=a; nuisance=two' }), f.env, undefined);
  expect(f.handler).toHaveBeenCalledTimes(12);
});

it('bypasses caching for invalid cookie selectors', async () => {
  const f = fixture();
  const base = profile.readResponseLease;
  if (!base) throw Error('lease policy missing');
  for (const config of [
    { ...base, cookieNames:[] }, { ...base, cookieNames:['bad name'] },
    { ...base, cookieNames:['session', 'session'] },
    { ...base, credentialHeaders:['authorization'], cookieNames:['session'] },
    { ...base, freshnessCookieMode:'generation', cookieNames:['session'] },
  ]) {
    const wrapped = wrapD1ReadResponseLease(f.handler, { ...profile, readResponseLease:config });
    await wrapped(f.req(), f.env, undefined); await wrapped(f.req(), f.env, undefined);
  }
  expect(f.handler).toHaveBeenCalledTimes(10);
});

it('isolates spaced and tabbed credential cookie names while ignoring nuisance cookies', async () => {
  const f = fixture();
  const base = profile.readResponseLease;
  if (!base) throw Error('lease policy missing');
  const wrapped = wrapD1ReadResponseLease(f.handler, { ...profile, readResponseLease:{ ...base, cookieNames:['session', 'access', 'fresh'] } });
  const read = (cookie: string) => wrapped(f.req({ cookie }), f.env, undefined);
  await read('session=invalid; access =a; nuisance=one');
  await read('session=invalid; access =a; nuisance=two');
  await read('session=invalid; access =b; nuisance=two');
  await read('session=invalid; access\t=a; nuisance=one');
  await read('session=invalid; access\t=b; nuisance=one');
  expect(f.handler).toHaveBeenCalledTimes(4);
});

it('bypasses duplicate and legacy freshness markers with spaced names', async () => {
  const f = fixture();
  const base = profile.readResponseLease;
  if (!base) throw Error('lease policy missing');
  const wrapped = wrapD1ReadResponseLease(f.handler, { ...profile, readResponseLease:{ ...base, freshnessCookieMode:'generation', cookieNames:['session', 'fresh'] } });
  for (const cookie of ['session=a; fresh =1', 'session=a; fresh\t=00000000-0000-4000-8000-000000000000; fresh=00000000-0000-4000-8000-000000000000']) {
    await wrapped(f.req({ cookie }), f.env, undefined);
    await wrapped(f.req({ cookie }), f.env, undefined);
  }
  expect(f.handler).toHaveBeenCalledTimes(4);
});

it('writes never hit and a successful write marker forces a fresh read across requests', async () => {
  const f = fixture();
  await f.wrapped(f.req(), f.env, undefined);
  const write = await f.wrapped(f.req({}, 'https://test.example/metadata', 'POST'), f.env, undefined);
  expect(write.headers.get('set-cookie')).toContain('fresh=1; Max-Age=5; Path=/; HttpOnly; SameSite=Lax; Secure');
  expect(await (await f.wrapped(f.req({ cookie:'session=a; fresh=1' }), f.env, undefined)).json()).toHaveProperty('calls', 3);
  expect(await (await f.wrapped(f.req({ cookie:'session=a; fresh=1' }, 'https://test.example/other'), f.env, undefined)).json()).toHaveProperty('control', 'no-cache');
  expect(await (await f.wrapped(f.req({ 'cache-control':'no-cache' }), f.env, undefined)).json()).toHaveProperty('calls', 5);
});

it('requires an explicit future authentication deadline and never slides expiration', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  const f = fixture();
  let deadline: number | undefined = undefined;
  let calls = 0;
  const handler = vi.fn(async () => { limitD1ReadLeaseUntil(deadline); return Response.json({ calls:++calls }); });
  const wrapped = wrapD1ReadResponseLease(handler, profile);
  await wrapped(f.req(), f.env, undefined); await wrapped(f.req(), f.env, undefined);
  expect(handler).toHaveBeenCalledTimes(2);
  deadline = 100_000;
  await wrapped(f.req(), f.env, undefined); await wrapped(f.req(), f.env, undefined);
  expect(handler).toHaveBeenCalledTimes(4);
  deadline = 103_000;
  await wrapped(f.req(), f.env, undefined);
  vi.setSystemTime(102_999);
  await wrapped(f.req(), f.env, undefined);
  expect(handler).toHaveBeenCalledTimes(5);
  vi.setSystemTime(103_000);
  await wrapped(f.req(), f.env, undefined);
  expect(handler).toHaveBeenCalledTimes(6);
});

it('bypasses missing credentials, conditionals and unsafe responses', async () => {
  const f = fixture();
  const requests = [new Request('https://test.example/metadata'), f.req({ range:'bytes=0-2' }), f.req({ 'if-match':'x' })];
  for (const request of requests) { await f.wrapped(request, f.env, undefined); await f.wrapped(request, f.env, undefined); }
  expect(f.handler).toHaveBeenCalledTimes(6);
  for (const response of [new Response('{}', { status:401, headers:{ 'content-type':'application/json' } }), new Response('{}', { headers:{ 'content-type':'application/json', 'set-cookie':'secret=x' } }), new Response('text'), new Response('{}', { headers:{ 'content-type':'application/json', vary:'X-Unknown' } }), new Response(JSON.stringify({ data:'x'.repeat(8_000_001) }), { headers:{ 'content-type':'application/json' } })]) {
    const load = vi.fn(async () => { limitD1ReadLeaseUntil(Date.now() + 5000); return response.clone(); });
    const wrapped = wrapD1ReadResponseLease(load, profile);
    await wrapped(f.req(), f.env, undefined); await wrapped(f.req(), f.env, undefined);
    expect(load).toHaveBeenCalledTimes(2);
  }
});

it('evaluates GET validators against a warm lease without invoking the source', async () => {
  const f = fixture();
  const source = vi.fn(async () => {
    limitD1ReadLeaseUntil(Date.now() + 10_000);
    return Response.json({ value:'cached' }, { headers:{ etag:'"a,b"', 'last-modified':'Wed, 21 Oct 2015 07:28:00 GMT', 'cache-control':'private, no-store', 'access-control-allow-origin':'https://site.example', vary:'Origin' } });
  });
  const wrapped = wrapD1ReadResponseLease(source, profile);
  await wrapped(f.req(), f.env, undefined);
  const matches: Array<Record<string,string>> = [
    { 'if-none-match':'"a,b"' }, { 'if-none-match':'W/"a,b"' },
    { 'if-none-match':'"other", W/"a,b"' }, { 'if-none-match':'*' },
    { 'if-modified-since':'Wed, 21 Oct 2015 07:28:00 GMT' },
    { 'if-modified-since':'Wed, 21 Oct 2015 07:29:00 GMT' },
    { 'if-modified-since':'Wednesday, 21-Oct-15 07:28:00 GMT' },
    { 'if-modified-since':'Wed Oct 21 07:28:00 2015' },
  ];
  for (const headers of matches) {
    const response = await wrapped(f.req(headers), f.env, undefined);
    expect(response.status, JSON.stringify(headers)).toBe(304);
    expect(await response.text()).toBe('');
    expect(response.headers.get('etag')).toBe('"a,b"');
    expect(response.headers.get('last-modified')).toBe('Wed, 21 Oct 2015 07:28:00 GMT');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('access-control-allow-origin')).toBe('https://site.example');
    expect(response.headers.has('content-length')).toBe(false);
  }
  const nonmatches: Array<Record<string,string>> = [
    { 'if-none-match':'"other"' }, { 'if-none-match':'"a", "b"' },
    { 'if-none-match':'"a,b", invalid' }, { 'if-modified-since':'invalid' },
    { 'if-modified-since':'Fri, 31 Feb 2023 07:28:00 GMT' },
    { 'if-modified-since':'Wed, 21 Oct 2015 07:27:59 GMT' },
    { 'if-none-match':'"other"', 'if-modified-since':'Wed, 21 Oct 2015 07:29:00 GMT' },
  ];
  for (const headers of nonmatches) {
    const response = await wrapped(f.req(headers), f.env, undefined);
    expect(response.status, JSON.stringify(headers)).toBe(200);
    expect(await response.json()).toEqual({ value:'cached' });
  }
  expect(source).toHaveBeenCalledTimes(1);
  for (const header of ['range', 'if-match', 'if-unmodified-since', 'if-range']) await wrapped(f.req({ [header]:'x' }), f.env, undefined);
  expect(source).toHaveBeenCalledTimes(5);
});

it('honors wildcard validators on warm responses without an entity tag', async () => {
  const f = fixture();
  await f.wrapped(f.req(), f.env, undefined);
  const response = await f.wrapped(f.req({ 'if-none-match':'*' }), f.env, undefined);
  expect(response.status).toBe(304);
  expect(f.handler).toHaveBeenCalledTimes(1);
});

it('falls back on cache failures and rejects an expired slow fill', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  const f = fixture();
  cache.match.mockRejectedValueOnce(Error('down'));
  cache.put.mockRejectedValueOnce(Error('down'));
  expect(await (await f.wrapped(f.req(), f.env, undefined)).json()).toHaveProperty('calls', 1);
  let resume: (() => void) | undefined;
  let reached: (() => void) | undefined;
  const paused = new Promise<void>((resolve) => { resume = resolve; });
  const started = new Promise<void>((resolve) => { reached = resolve; });
  const slow = wrapD1ReadResponseLease(async () => { limitD1ReadLeaseUntil(120_000); reached?.(); await paused; return Response.json({ slow:true }); }, profile);
  const result = slow(f.req(), f.env, undefined);
  await started; vi.setSystemTime(105_000); resume?.(); await result;
  expect(entries.size).toBe(0);
});

it('admits only whole-segment path patterns and does not fill when authentication omits the deadline', async () => {
  const f = fixture();
  const run = async (url: string) => f.wrapped(f.req({}, url), f.env, undefined);
  await run('https://test.example/items/one'); await run('https://test.example/items/one');
  expect(f.handler).toHaveBeenCalledTimes(1);
  await run('https://test.example/items/one/secret'); await run('https://test.example/items/one/secret');
  expect(f.handler).toHaveBeenCalledTimes(3);
  const noDeadline = vi.fn(async () => Response.json({ ok:true }));
  const wrapped = wrapD1ReadResponseLease(noDeadline, profile);
  await wrapped(f.req({}, 'https://test.example/metadata?missing=1'), f.env, undefined);
  await wrapped(f.req({}, 'https://test.example/metadata?missing=1'), f.env, undefined);
  expect(noDeadline).toHaveBeenCalledTimes(2);
});

it('expires five seconds from the source request without extending on hits', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  const f = fixture();
  await f.wrapped(f.req(), f.env, undefined);
  vi.setSystemTime(104_999);
  await f.wrapped(f.req(), f.env, undefined);
  expect(f.handler).toHaveBeenCalledTimes(1);
  vi.setSystemTime(105_000);
  await f.wrapped(f.req(), f.env, undefined);
  expect(f.handler).toHaveBeenCalledTimes(2);
});

it('falls back for malformed cached entries and leaves disabled requests untouched', async () => {
  const f = fixture();
  await f.wrapped(f.req(), f.env, undefined);
  for (const key of entries.keys()) entries.set(key, new Response('invalid'));
  expect(await (await f.wrapped(f.req(), f.env, undefined)).json()).toHaveProperty('calls', 2);
  const request = f.req({ cookie:'session=a; fresh=1' });
  await f.wrapped(request, { ...f.env, TEST_READ_ACCESS_SECONDS:'0' }, undefined);
  expect(f.handler.mock.calls.at(-1)?.[0]).toBe(request);
});

it('streams validated hits with original headers and rejects invalid lease metadata', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  const f = fixture();
  await f.wrapped(f.req(), f.env, undefined);
  const warm = await f.wrapped(f.req(), f.env, undefined);
  expect(warm.bodyUsed).toBe(false);
  expect(warm.headers.get('cache-control')).toBe('private, no-store');
  expect(warm.headers.has('x-dee-wan-lease-meta')).toBe(false);
  expect(await warm.json()).toHaveProperty('calls', 1);
  for (const value of ['invalid', '[100000,106000,null]', '[100001,105000,null]', '[100000,100000,null]']) {
    for (const [key, cached] of entries) {
      const headers = new Headers(cached.headers);
      headers.set('x-dee-wan-lease-meta', value);
      entries.set(key, new Response('{}', { headers }));
    }
    await f.wrapped(f.req(), f.env, undefined);
  }
  expect(f.handler).toHaveBeenCalledTimes(5);
});

it('returns a cache hit before its body stream becomes available', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  const f = fixture();
  const original = await (await f.wrapped(f.req(), f.env, undefined)).text();
  let release: (() => void) | undefined;
  for (const [key, cached] of entries) {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        release = () => { controller.enqueue(new TextEncoder().encode(original)); controller.close(); };
      },
    });
    entries.set(key, new Response(body, { status:cached.status, statusText:cached.statusText, headers:cached.headers }));
  }
  let signalArrival: (() => void) | undefined;
  const arrival = new Promise<void>((resolve) => { signalArrival = resolve; });
  cache.match.mockImplementationOnce(async (key: string) => {
    const cached = entries.get(key)?.clone();
    signalArrival?.();
    return cached;
  });
  let resolved = false;
  const pending = f.wrapped(f.req(), f.env, undefined).then((response) => { resolved = true; return response; });
  try {
    await arrival;
    await vi.advanceTimersByTimeAsync(1001);
    expect(resolved).toBe(true);
    expect(f.handler).toHaveBeenCalledTimes(1);
  } finally { release?.(); }
  const hit = await pending;
  expect(await hit.text()).toBe(original);
});

it('does not cache a source response containing reserved lease metadata', async () => {
  const f = fixture();
  const source = vi.fn(async () => {
    limitD1ReadLeaseUntil(Date.now() + 5000);
    return Response.json({ ok:true }, { headers:{ 'x-dee-wan-lease-meta':'source' } });
  });
  const wrapped = wrapD1ReadResponseLease(source, profile);
  await wrapped(f.req(), f.env, undefined);
  await wrapped(f.req(), f.env, undefined);
  expect(source).toHaveBeenCalledTimes(2);
});

it('keeps authentication deadlines request-local across concurrent fills', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  const f = fixture();
  let resume: (() => void) | undefined;
  let reached: (() => void) | undefined;
  const paused = new Promise<void>((resolve) => { resume = resolve; });
  const started = new Promise<void>((resolve) => { reached = resolve; });
  const load = vi.fn(async (request: Request) => {
    const isA = request.headers.get('cookie') === 'session=a';
    limitD1ReadLeaseUntil(isA ? 101_000 : 104_000);
    if (isA) { reached?.(); await paused; }
    return Response.json({ credential:isA ? 'a' : 'b' });
  });
  const wrapped = wrapD1ReadResponseLease(load, profile);
  const first = wrapped(f.req(), f.env, undefined);
  await started;
  await wrapped(f.req({ cookie:'session=b' }), f.env, undefined);
  resume?.(); await first;
  vi.setSystemTime(101_000);
  await wrapped(f.req(), f.env, undefined);
  await wrapped(f.req({ cookie:'session=b' }), f.env, undefined);
  expect(load).toHaveBeenCalledTimes(3);
});


it('ignores unconfigured tracing headers and bypasses configured query keys', async () => {
  const f = fixture();
  await f.wrapped(f.req({ 'cf-ray':'first', 'x-request-id':'first', 'x-trace-custom':'first' }), f.env, undefined);
  await f.wrapped(f.req({ 'cf-ray':'second', 'x-request-id':'second', 'x-trace-custom':'second' }), f.env, undefined);
  expect(f.handler).toHaveBeenCalledTimes(1);
  await f.wrapped(f.req({}, 'https://test.example/metadata?q=test'), f.env, undefined);
  await f.wrapped(f.req({}, 'https://test.example/metadata?q=test'), f.env, undefined);
  expect(f.handler).toHaveBeenCalledTimes(3);
});


it('transports verified origin deadlines and strips forged request and response proofs', async () => {
  const f = fixture();
  let authorized = true;
  let calls = 0;
  const origin = vi.fn(async (request: Request) => {
    expect(request.headers.has('x-dee-wan-read-lease-deadline')).toBe(false);
    if (authorized) limitD1ReadLeaseUntil(Date.now() + 5000);
    return Response.json({ count:++calls }, { headers:{ 'cache-control':'private, no-store', 'x-dee-wan-read-lease-deadline':'9999999999999' } });
  });
  const source = wrapD1ReadLeaseOrigin(origin);
  const service = { fetch:(request: Request) => source(request, undefined, undefined) };
  const gateway = wrapD1ReadResponseLease((request) => forwardD1ReadLease(request, service), profile);
  const req = f.req({ 'x-dee-wan-read-lease-deadline':'9999999999999' });
  const first = await gateway(req, f.env, undefined);
  expect(first.headers.has('x-dee-wan-read-lease-deadline')).toBe(false);
  expect(await first.json()).toHaveProperty('count', 1);
  expect(await (await gateway(req, f.env, undefined)).json()).toHaveProperty('count', 1);
  expect(origin).toHaveBeenCalledTimes(1);
  authorized = false;
  const other = f.req({ cookie:'session=b', 'x-dee-wan-read-lease-deadline':'9999999999999' });
  const denied = await gateway(other, f.env, undefined);
  expect(denied.headers.has('x-dee-wan-read-lease-deadline')).toBe(false);
  await gateway(other, f.env, undefined);
  expect(origin).toHaveBeenCalledTimes(3);
});

it('does not add proof to event streams or responses setting cookies', async () => {
  for (const response of [new Response('data: hello\n\n', { headers:{ 'content-type':'text/event-stream' } }), Response.json({}, { headers:{ 'set-cookie':'session=x' } })]) {
    const origin = wrapD1ReadLeaseOrigin(async () => { limitD1ReadLeaseUntil(Date.now() + 5000); return response; });
    const result = await origin(new Request('https://test.example/metadata'), undefined, undefined);
    expect(result).toBe(response);
    expect(result.headers.has('x-dee-wan-read-lease-deadline')).toBe(false);
  }
});

it('optionally reuses leases despite browser cache directives while explicit freshness forces the source', async () => {
  const f = fixture();
  const base = profile.readResponseLease;
  if (!base) throw Error('lease policy missing');
  const policy: D1CacheProfile = { ...profile, readResponseLease:{ ...base, ignoreRequestCacheControl:true, freshnessHeader:'x-read-fresh' } };
  const wrapped = wrapD1ReadResponseLease(f.handler, policy);
  const run = (headers: Record<string,string> = {}) => wrapped(f.req(headers), f.env, undefined);
  expect(await (await run({ 'cache-control':'no-cache' })).json()).toHaveProperty('calls', 1);
  expect(await (await run({ 'cache-control':'no-store' })).json()).toHaveProperty('calls', 1);
  expect(f.handler).toHaveBeenCalledTimes(1);
  expect(await (await run({ 'x-read-fresh':'1', 'cache-control':'no-store' })).json()).toHaveProperty('calls', 2);
  expect(f.handler.mock.calls.at(-1)?.[0].headers.get('cache-control')).toBe('no-cache');
  expect(await (await run({ cookie:'session=a; fresh=1', 'cache-control':'no-cache' })).json()).toHaveProperty('calls', 3);
  const write = await wrapped(f.req({}, 'https://test.example/metadata', 'POST'), f.env, undefined);
  expect(write.headers.get('set-cookie')).toContain('fresh=1');
  expect(f.handler).toHaveBeenCalledTimes(4);
  expect(await (await run()).json()).toHaveProperty('calls', 2);
});

it('preserves default cache directive bypass and fails safe for an invalid freshness header', async () => {
  const f = fixture();
  await f.wrapped(f.req({ 'cache-control':'no-cache' }), f.env, undefined);
  await f.wrapped(f.req({ 'cache-control':'no-store' }), f.env, undefined);
  expect(f.handler).toHaveBeenCalledTimes(2);
  const base = profile.readResponseLease;
  if (!base) throw Error('lease policy missing');
  const invalid: D1CacheProfile = { ...profile, readResponseLease:{ ...base, ignoreRequestCacheControl:true, freshnessHeader:'bad header' } };
  const wrapped = wrapD1ReadResponseLease(f.handler, invalid);
  await wrapped(f.req(), f.env, undefined);
  await wrapped(f.req(), f.env, undefined);
  expect(f.handler).toHaveBeenCalledTimes(4);
  expect(f.handler.mock.calls.at(-1)?.[0].headers.get('cache-control')).toBe('no-cache');
});

it('loads fresh metadata and replaces the lease after explicit freshness', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  const f = fixture();
  const base = profile.readResponseLease;
  if (!base) throw Error('lease policy missing');
  const config = { ...base, maxSeconds:30, ignoreRequestCacheControl:true, freshnessHeader:'x-read-fresh' };
  const policy: D1CacheProfile = { ...profile, readResponseLease:config };
  const env = { ...f.env, TEST_READ_ACCESS_SECONDS:'30' };
  let calls = 0;
  const handler = vi.fn(async (request: Request) => {
    limitD1ReadLeaseUntil(200_000);
    return Response.json({ calls:++calls, fresh:request.headers.get('x-read-fresh'), control:request.headers.get('cache-control'), metadataTtl:regionalD1MetadataTtl(request, config) });
  });
  const wrapped = wrapD1ReadResponseLease(handler, policy);
  expect(await (await wrapped(f.req(), env, undefined)).json()).toMatchObject({ calls:1, fresh:'1', control:'no-cache', metadataTtl:0 });
  vi.setSystemTime(106_000);
  expect(await (await wrapped(f.req(), env, undefined)).json()).toHaveProperty('calls', 1);
  expect(handler).toHaveBeenCalledTimes(1);
  expect(await (await wrapped(f.req({ 'x-read-fresh':'1' }), env, undefined)).json()).toHaveProperty('calls', 2);
  expect(await (await wrapped(f.req(), env, undefined)).json()).toHaveProperty('calls', 2);
  expect(handler).toHaveBeenCalledTimes(2);
  vi.setSystemTime(135_999);
  expect(await (await wrapped(f.req(), env, undefined)).json()).toHaveProperty('calls', 2);
  vi.setSystemTime(136_000);
  expect(await (await wrapped(f.req(), env, undefined)).json()).toHaveProperty('calls', 3);
});

it('does not replace a warm lease with an unsafe fresh source response', async () => {
  const f = fixture();
  const base = profile.readResponseLease;
  if (!base) throw Error('lease policy missing');
  let calls = 0;
  const source = vi.fn(async () => {
    limitD1ReadLeaseUntil(Date.now() + 10_000);
    return ++calls === 1 ? Response.json({ calls }) : new Response('{}', { status:401, headers:{ 'content-type':'application/json' } });
  });
  const wrapped = wrapD1ReadResponseLease(source, { ...profile, readResponseLease:{ ...base, freshnessHeader:'x-read-fresh' } });
  expect(await (await wrapped(f.req(), f.env, undefined)).json()).toHaveProperty('calls', 1);
  expect((await wrapped(f.req({ 'x-read-fresh':'1' }), f.env, undefined)).status).toBe(401);
  expect(await (await wrapped(f.req(), f.env, undefined)).json()).toHaveProperty('calls', 1);
  expect(source).toHaveBeenCalledTimes(2);
});

it('omits the freshness cookie only for excluded write paths and keeps the handler response intact', async () => {
  const f = fixture();
  const base = profile.readResponseLease;
  if (!base) throw Error('lease policy missing');
  const policy: D1CacheProfile = { ...profile, readResponseLease:{ ...base, freshnessCookieExcludedPaths:['/items/*/presence'] } };
  const wrapped = wrapD1ReadResponseLease(f.handler, policy);
  await wrapped(f.req(), f.env, undefined);
  const excluded = await wrapped(f.req({}, 'https://test.example/items/1/presence', 'POST'), f.env, undefined);
  expect(excluded.headers.has('set-cookie')).toBe(false);
  expect(f.handler).toHaveBeenCalledTimes(2);
  expect(await (await wrapped(f.req(), f.env, undefined)).json()).toHaveProperty('calls', 1);
  expect(f.handler).toHaveBeenCalledTimes(2);
  const ordinary = await wrapped(f.req({}, 'https://test.example/items/1/presence/extra', 'POST'), f.env, undefined);
  expect(ordinary.headers.get('set-cookie')).toContain('fresh=1');
  const fresh = await wrapped(f.req({ cookie:'session=a; fresh=1' }), f.env, undefined);
  expect(await fresh.json()).toHaveProperty('control', 'no-cache');
  expect(f.handler).toHaveBeenCalledTimes(4);
  const existing = new Response('{}', { headers:{ 'set-cookie':'other=value; HttpOnly' } });
  const withCookie = wrapD1ReadResponseLease(async () => existing, policy);
  const unchanged = await withCookie(f.req({}, 'https://test.example/items/1/presence', 'POST'), f.env, undefined);
  expect(unchanged).toBe(existing);
  expect(unchanged.headers.get('set-cookie')).toContain('other=value');
});

it('caps an outer response lease at the inner regional data expiry across the origin binding', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  const f = fixture();
  const base = profile.readResponseLease;
  if (!base) throw Error('lease policy missing');
  const longPolicy: D1CacheProfile = { ...profile, readResponseLease:{ ...base, maxSeconds:300 } };
  const env = { ...f.env, TEST_READ_ACCESS_SECONDS:'300' };
  const coordinator: CacheStore = {
    beginWrite:async () => {}, endWrite:async () => {}, invalidate:async () => {}, release:async () => {},
    read:async () => ({ kind:'miss', epochs:{ g:0 }, lockHeldForMs:null, lockToken:'lock', pending:false }),
    write:async () => ({ ok:true }),
  };
  const db = createD1CacheRuntime(binding, { store:coordinator, databaseId:'data', generation:'1', coordinatorName:'data', regionalIdentity:'data-coord', profile });
  let loads = 0;
  const data = () => cacheD1Read(db, { key:'metadata', scope:'actor', regionalTtlMs:5000 }, async () => ++loads);
  expect(await data()).toBe(1);
  vi.setSystemTime(104_000);
  let originCalls = 0;
  const source = wrapD1ReadLeaseOrigin(async () => { originCalls++; limitD1ReadLeaseUntil(120_000); return Response.json({ value:await data() }); });
  const gateway = wrapD1ReadResponseLease((request) => forwardD1ReadLease(request, { fetch:(incoming) => source(incoming, undefined, undefined) }), longPolicy);
  expect(await (await gateway(f.req(), env, undefined)).json()).toHaveProperty('value', 1);
  vi.setSystemTime(104_999);
  expect(await (await gateway(f.req(), env, undefined)).json()).toHaveProperty('value', 1);
  expect(originCalls).toBe(1);
  vi.setSystemTime(105_000);
  expect(await (await gateway(f.req(), env, undefined)).json()).toHaveProperty('value', 2);
  expect(originCalls).toBe(2);
  expect(loads).toBe(2);
  vi.setSystemTime(105_001);
  expect(await (await gateway(f.req(), env, undefined)).json()).toHaveProperty('value', 2);
  expect(originCalls).toBe(2);
});

it('does not mistake a regional data deadline for an authentication proof', async () => {
  const f = fixture();
  const coordinator: CacheStore = {
    beginWrite:async () => {}, endWrite:async () => {}, invalidate:async () => {}, release:async () => {},
    read:async () => ({ kind:'miss', epochs:{ g:0 }, lockHeldForMs:null, lockToken:'lock', pending:false }),
    write:async () => ({ ok:true }),
  };
  const db = createD1CacheRuntime(binding, { store:coordinator, databaseId:'data', generation:'1', coordinatorName:'data', regionalIdentity:'data-coord', profile });
  const data = () => cacheD1Read(db, { key:'auth-proof', scope:'actor', regionalTtlMs:5000 }, async () => 1);
  await data();
  let calls = 0;
  const source = wrapD1ReadLeaseOrigin(async () => { calls++; return Response.json({ value:await data() }); });
  const gateway = wrapD1ReadResponseLease((request) => forwardD1ReadLease(request, { fetch:(incoming) => source(incoming, undefined, undefined) }), profile);
  await gateway(f.req(), f.env, undefined);
  await gateway(f.req(), f.env, undefined);
  expect(calls).toBe(2);
});

it('opts into thirty-second leases without sliding and makes writer-marker reads fresh', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  const f = fixture();
  const base = profile.readResponseLease;
  if (!base) throw Error('lease policy missing');
  const policy: D1CacheProfile = { ...profile, readResponseLease:{ ...base, maxSeconds:30, freshnessHeader:'x-read-fresh' } };
  const env = { ...f.env, TEST_READ_ACCESS_SECONDS:'30' };
  let calls = 0;
  const handler = vi.fn(async () => { limitD1ReadLeaseUntil(200_000); return Response.json({ calls:++calls }); });
  const wrapped = wrapD1ReadResponseLease(handler, policy);
  expect(await (await wrapped(f.req(), env, undefined)).json()).toHaveProperty('calls', 1);
  vi.setSystemTime(129_999);
  expect(await (await wrapped(f.req(), env, undefined)).json()).toHaveProperty('calls', 1);
  const write = await wrapped(f.req({}, 'https://test.example/metadata', 'POST'), env, undefined);
  expect(write.headers.get('set-cookie')).toContain('fresh=1; Max-Age=30;');
  expect(await (await wrapped(f.req({ cookie:'session=a; fresh=1' }), env, undefined)).json()).toHaveProperty('calls', 3);
  expect(await (await wrapped(f.req({ 'x-read-fresh':'1' }), env, undefined)).json()).toHaveProperty('calls', 4);
  vi.setSystemTime(130_000);
  expect(await (await wrapped(f.req(), env, undefined)).json()).toHaveProperty('calls', 4);
  vi.setSystemTime(159_999);
  expect(await (await wrapped(f.req(), env, undefined)).json()).toHaveProperty('calls', 5);
});

it('rejects excess or invalid response lease configuration and caps long leases at session expiry', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  const f = fixture();
  const base = profile.readResponseLease;
  if (!base) throw Error('lease policy missing');
  const env = { ...f.env, TEST_READ_ACCESS_SECONDS:'30' };
  const defaultPolicy = wrapD1ReadResponseLease(f.handler, profile);
  await defaultPolicy(f.req(), env, undefined); await defaultPolicy(f.req(), env, undefined);
  expect(f.handler).toHaveBeenCalledTimes(2);
  for (const maxSeconds of [0, 301, 1.5]) {
    const invalid = wrapD1ReadResponseLease(f.handler, { ...profile, readResponseLease:{ ...base, maxSeconds } });
    await invalid(f.req(), env, undefined); await invalid(f.req(), env, undefined);
  }
  expect(f.handler).toHaveBeenCalledTimes(8);
  let calls = 0;
  const source = vi.fn(async () => { limitD1ReadLeaseUntil(110_000); return Response.json({ calls:++calls }); });
  const valid = wrapD1ReadResponseLease(source, { ...profile, readResponseLease:{ ...base, maxSeconds:30 } });
  await valid(f.req(), env, undefined);
  vi.setSystemTime(109_999); await valid(f.req(), env, undefined);
  expect(source).toHaveBeenCalledTimes(1);
  vi.setSystemTime(110_000); await valid(f.req(), env, undefined);
  expect(source).toHaveBeenCalledTimes(2);
});

it('uses a fresh cookie generation as a lease key after each write while legacy markers bypass', async () => {
  const f = fixture();
  const base = profile.readResponseLease;
  if (!base) throw Error('lease policy missing');
  const policy: D1CacheProfile = { ...profile, readResponseLease:{ ...base, maxSeconds:30, freshnessCookieMode:'generation', freshnessHeader:'x-read-fresh' } };
  const env = { ...f.env, TEST_READ_ACCESS_SECONDS:'30' };
  let calls = 0;
  const handler = vi.fn(async (request: Request) => {
    limitD1ReadLeaseUntil(Date.now() + 60_000);
    return Response.json({ calls:++calls, ttl:regionalD1MetadataTtl(request, policy.readResponseLease ?? base) });
  });
  const wrapped = wrapD1ReadResponseLease(handler, policy);
  const run = (cookie: string) => wrapped(f.req({ cookie }), env, undefined);
  expect(await (await run('session=a')).json()).toHaveProperty('calls', 1);
  const firstWrite = await wrapped(f.req({}, 'https://test.example/metadata', 'POST'), env, undefined);
  const first = firstWrite.headers.get('set-cookie')?.match(/fresh=([^;]+)/)?.[1];
  expect(first).toMatch(/^[0-9a-f-]{36}$/);
  expect(firstWrite.headers.get('set-cookie')).toContain('Max-Age=30');
  const cookie1 = `session=a; fresh=${first}`;
  expect(await (await run(cookie1)).json()).toEqual({ calls:3, ttl:0 });
  expect(await (await run(cookie1)).json()).toEqual({ calls:3, ttl:0 });
  const nextWrite = await wrapped(f.req({}, 'https://test.example/metadata', 'POST'), env, undefined);
  const second = nextWrite.headers.get('set-cookie')?.match(/fresh=([^;]+)/)?.[1];
  expect(second).toMatch(/^[0-9a-f-]{36}$/);
  expect(second).not.toBe(first);
  expect(await (await run(`session=a; fresh=${second}`)).json()).toEqual({ calls:5, ttl:0 });
  expect(await (await run(`session=a; fresh=${second}`)).json()).toEqual({ calls:5, ttl:0 });
  expect(await (await run('session=a; fresh=1')).json()).toHaveProperty('calls', 6);
  expect(await (await run('session=a; fresh=1')).json()).toHaveProperty('calls', 7);
  expect(await (await wrapped(f.req({ cookie:cookie1, 'x-read-fresh':'1' }), env, undefined)).json()).toHaveProperty('calls', 8);
});

it('keeps bypass markers when generation mode has no cookie credential in its key', async () => {
  const f = fixture();
  const base = profile.readResponseLease;
  if (!base) throw Error('lease policy missing');
  const policy: D1CacheProfile = { ...profile, readResponseLease:{ ...base, freshnessCookieMode:'generation', credentialHeaders:['authorization'] } };
  const wrapped = wrapD1ReadResponseLease(f.handler, policy);
  const response = await wrapped(f.req({ authorization:'Bearer x' }, 'https://test.example/metadata', 'POST'), f.env, undefined);
  expect(response.headers.get('set-cookie')).toContain('fresh=1;');
});

it('supports a non-sliding 300-second generation lease with fresh writer reads', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  const f = fixture();
  const base = profile.readResponseLease;
  if (!base) throw Error('lease policy missing');
  const policy: D1CacheProfile = { ...profile, readResponseLease:{ ...base, maxSeconds:300, freshnessCookieMode:'generation', freshnessHeader:'x-read-fresh' } };
  const env = { ...f.env, TEST_READ_ACCESS_SECONDS:'300' };
  let calls = 0;
  const handler = vi.fn(async () => { limitD1ReadLeaseUntil(500_000); return Response.json({ calls:++calls }); });
  const wrapped = wrapD1ReadResponseLease(handler, policy);
  expect(await (await wrapped(f.req(), env, undefined)).json()).toHaveProperty('calls', 1);
  vi.setSystemTime(399_999);
  expect(await (await wrapped(f.req(), env, undefined)).json()).toHaveProperty('calls', 1);
  const write = await wrapped(f.req({}, 'https://test.example/metadata', 'POST'), env, undefined);
  expect(write.headers.get('set-cookie')).toContain('Max-Age=300;');
  const nonce = write.headers.get('set-cookie')?.match(/fresh=([^;]+)/)?.[1];
  expect(nonce).toMatch(/^[0-9a-f-]{36}$/);
  const fresh = f.req({ cookie:`session=a; fresh=${nonce}` });
  expect(await (await wrapped(fresh, env, undefined)).json()).toHaveProperty('calls', 3);
  expect(await (await wrapped(fresh, env, undefined)).json()).toHaveProperty('calls', 3);
  vi.setSystemTime(400_000);
  expect(await (await wrapped(f.req(), env, undefined)).json()).toHaveProperty('calls', 4);
});

it('rejects a 301-second maximum and malformed access values', async () => {
  const f = fixture();
  const base = profile.readResponseLease;
  if (!base) throw Error('lease policy missing');
  const rejectedMax: D1CacheProfile = { ...profile, readResponseLease:{ ...base, maxSeconds:301 } };
  const rejected = wrapD1ReadResponseLease(f.handler, rejectedMax);
  await rejected(f.req(), { ...f.env, TEST_READ_ACCESS_SECONDS:'300' }, undefined);
  await rejected(f.req(), { ...f.env, TEST_READ_ACCESS_SECONDS:'300' }, undefined);
  const policy: D1CacheProfile = { ...profile, readResponseLease:{ ...base, maxSeconds:300 } };
  const wrapped = wrapD1ReadResponseLease(f.handler, policy);
  for (const value of ['301', '0300', '300.0', '1e2', '-1', ' 300', '300 ']) {
    await wrapped(f.req(), { ...f.env, TEST_READ_ACCESS_SECONDS:value }, undefined);
    await wrapped(f.req(), { ...f.env, TEST_READ_ACCESS_SECONDS:value }, undefined);
  }
  expect(f.handler).toHaveBeenCalledTimes(16);
});

it('caps a 300-second lease at the verified session deadline', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  const f = fixture();
  const base = profile.readResponseLease;
  if (!base) throw Error('lease policy missing');
  const policy: D1CacheProfile = { ...profile, readResponseLease:{ ...base, maxSeconds:300 } };
  const env = { ...f.env, TEST_READ_ACCESS_SECONDS:'300' };
  let calls = 0;
  const wrapped = wrapD1ReadResponseLease(async () => { limitD1ReadLeaseUntil(110_000); return Response.json({ calls:++calls }); }, policy);
  await wrapped(f.req(), env, undefined);
  vi.setSystemTime(109_999); await wrapped(f.req(), env, undefined);
  expect(calls).toBe(1);
  vi.setSystemTime(110_000); await wrapped(f.req(), env, undefined);
  expect(calls).toBe(2);
});

it('reuses multi-megabyte JSON responses and rejects oversized source bodies', async () => {
  const f = fixture();
  const body = JSON.stringify({ items:Array.from({ length:3000 }, (_, id) => ({ id, value:'x'.repeat(1000) })) });
  expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(3_000_000);
  let calls = 0;
  const handler = vi.fn(async () => { calls++; limitD1ReadLeaseUntil(Date.now() + 10_000); return new Response(body, { headers:{ 'content-type':'application/json', 'cache-control':'private, no-store' } }); });
  const wrapped = wrapD1ReadResponseLease(handler, profile);
  expect(await (await wrapped(f.req(), f.env, undefined)).text()).toBe(body);
  expect(await (await wrapped(f.req(), f.env, undefined)).text()).toBe(body);
  expect(calls).toBe(1);
  const escaped = JSON.stringify({ value:'"'.repeat(3_000_000) });
  expect(new TextEncoder().encode(escaped).byteLength).toBeLessThan(8_000_000);
  const escapedSource = vi.fn(async () => { limitD1ReadLeaseUntil(Date.now() + 10_000); return new Response(escaped, { headers:{ 'content-type':'application/json' } }); });
  const cached = wrapD1ReadResponseLease(escapedSource, profile);
  const escapedRequest = f.req({}, 'https://test.example/metadata?escaped=1');
  expect(await (await cached(escapedRequest, f.env, undefined)).text()).toBe(escaped);
  expect(await (await cached(escapedRequest, f.env, undefined)).text()).toBe(escaped);
  expect(escapedSource).toHaveBeenCalledTimes(1);
  const oversized = JSON.stringify({ value:'x'.repeat(8_000_001) });
  expect(new TextEncoder().encode(oversized).byteLength).toBeGreaterThan(8_000_000);
  const tooLarge = vi.fn(async () => { limitD1ReadLeaseUntil(Date.now() + 10_000); return new Response(oversized, { headers:{ 'content-type':'application/json' } }); });
  const rejected = wrapD1ReadResponseLease(tooLarge, profile);
  const request = f.req({}, 'https://test.example/metadata?oversize=1');
  await rejected(request, f.env, undefined); await rejected(request, f.env, undefined);
  expect(tooLarge).toHaveBeenCalledTimes(2);
});

it('requests identity encoding across the binding without changing the caller or credentials', async () => {
  const request = new Request('https://test.example/metadata', { headers:{ 'accept-encoding':'br, gzip', authorization:'Bearer token', cookie:'session=a', 'x-site-id':'site-a', 'x-dee-wan-read-lease-deadline':'forged' } });
  const fetch = vi.fn(async (forwarded: Request) => {
    expect(forwarded.headers.get('accept-encoding')).toBe('identity');
    expect(forwarded.headers.get('authorization')).toBe('Bearer token');
    expect(forwarded.headers.get('cookie')).toBe('session=a');
    expect(forwarded.headers.get('x-site-id')).toBe('site-a');
    expect(forwarded.headers.has('x-dee-wan-read-lease-deadline')).toBe(false);
    return Response.json({}, { headers:{ 'x-dee-wan-read-lease-deadline':'123' } });
  });
  const response = await forwardD1ReadLease(request, { fetch });
  expect(response.headers.has('x-dee-wan-read-lease-deadline')).toBe(false);
  expect(request.headers.get('accept-encoding')).toBe('br, gzip');
  expect(request.headers.get('authorization')).toBe('Bearer token');
  expect(request.headers.get('cookie')).toBe('session=a');
  expect(request.headers.get('x-site-id')).toBe('site-a');
  expect(request.headers.get('x-dee-wan-read-lease-deadline')).toBe('forged');
});

it('reuses a large identity-encoded origin response but still rejects encoded responses', async () => {
  const f = fixture();
  const body = JSON.stringify({ items:Array.from({ length:3000 }, (_, id) => ({ id, value:'x'.repeat(1000) })) });
  let calls = 0;
  let encoded = false;
  const source = wrapD1ReadLeaseOrigin(async (request: Request) => {
    expect(request.headers.get('accept-encoding')).toBe('identity');
    expect(request.headers.get('cookie')).toBe('session=a');
    expect(request.headers.get('x-site-id')).toBe('site-a');
    calls++;
    limitD1ReadLeaseUntil(Date.now() + 10_000);
    const headers = new Headers({ 'content-type':'application/json' });
    if (encoded) headers.set('content-encoding', 'gzip');
    return new Response(body, { headers });
  });
  const service = { fetch:(request: Request) => source(request, undefined, undefined) };
  const wrapped = wrapD1ReadResponseLease((request) => forwardD1ReadLease(request, service), profile);
  const request = f.req({ 'accept-encoding':'br, gzip', 'x-site-id':'site-a' });
  expect(await (await wrapped(request, f.env, undefined)).text()).toBe(body);
  expect(await (await wrapped(request, f.env, undefined)).text()).toBe(body);
  expect(calls).toBe(1);
  expect(request.headers.get('accept-encoding')).toBe('br, gzip');
  encoded = true;
  const other = f.req({ 'accept-encoding':'br, gzip', 'x-site-id':'site-a' }, 'https://test.example/metadata?encoded=1');
  await wrapped(other, f.env, undefined); await wrapped(other, f.env, undefined);
  expect(calls).toBe(3);
});

it('forwards write bodies without changing their encoding negotiation', async () => {
  const request = new Request('https://test.example/metadata', { method:'POST', body:'{"value":1}', headers:{ 'content-type':'application/json', 'accept-encoding':'br, gzip', cookie:'session=a', 'x-dee-wan-read-lease-deadline':'forged' } });
  const fetch = vi.fn(async (forwarded: Request) => {
    expect(forwarded.headers.get('accept-encoding')).toBe('br, gzip');
    expect(forwarded.headers.get('cookie')).toBe('session=a');
    expect(forwarded.headers.has('x-dee-wan-read-lease-deadline')).toBe(false);
    expect(await forwarded.text()).toBe('{"value":1}');
    return Response.json({ ok:true });
  });
  await forwardD1ReadLease(request, { fetch });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('returns a streaming source before background fill and caches bodies completing after one second', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  const f = fixture();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const load = vi.fn(async () => { limitD1ReadLeaseUntil(110_000); return new Response(stream, { headers:{ 'content-type':'application/json' } }); });
  const wrapped = wrapD1ReadResponseLease(load, profile);
  const tasks: Promise<void>[] = [];
  const context = { waitUntil(task: Promise<void>) { tasks.push(task); } };
  const first = await wrapped(f.req(), f.env, context);
  expect(tasks).toHaveLength(1);
  expect(cache.put).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1500);
  controller?.enqueue(new TextEncoder().encode('{"value":42}'));
  controller?.close();
  await tasks[0];
  expect(await first.json()).toEqual({ value:42 });
  expect(await (await wrapped(f.req(), f.env, context)).json()).toEqual({ value:42 });
  expect(load).toHaveBeenCalledTimes(1);
});

it('does not fill failed, non-JSON, or oversized background streams', async () => {
  const f = fixture();
  const cases = [
    () => new Response('invalid', { headers:{ 'content-type':'application/json' } }),
    () => new Response('not json', { headers:{ 'content-type':'text/plain' } }),
    () => new Response(JSON.stringify({ value:'x'.repeat(8_000_001) }), { headers:{ 'content-type':'application/json' } }),
    () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(Error('stream failed')); } }), { headers:{ 'content-type':'application/json' } }),
  ];
  for (let index = 0; index < cases.length; index++) {
    const make = cases[index];
    if (!make) throw Error('case missing');
    const load = vi.fn(async () => { limitD1ReadLeaseUntil(Date.now() + 10_000); return make(); });
    const wrapped = wrapD1ReadResponseLease(load, profile);
    const tasks: Promise<void>[] = [];
    const context = { waitUntil(task: Promise<void>) { tasks.push(task); } };
    const request = f.req({}, `https://test.example/metadata?case=${index}`);
    await wrapped(request, f.env, context);
    await tasks[0];
    await wrapped(request, f.env, context);
    await tasks[1];
    expect(load).toHaveBeenCalledTimes(2);
  }
  expect(cache.put).not.toHaveBeenCalled();
});

it('does not cache a background fill that outlives the authentication deadline', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  const f = fixture();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const wrapped = wrapD1ReadResponseLease(async () => { limitD1ReadLeaseUntil(102_000); return new Response(stream, { headers:{ 'content-type':'application/json' } }); }, profile);
  const tasks: Promise<void>[] = [];
  const context = { waitUntil(task: Promise<void>) { tasks.push(task); } };
  await wrapped(f.req(), f.env, context);
  await vi.advanceTimersByTimeAsync(2001);
  controller?.enqueue(new TextEncoder().encode('{}'));
  controller?.close();
  await tasks[0];
  expect(cache.put).not.toHaveBeenCalled();
});

it('reuses large nested UTF-8 JSON responses without changing their contents', async () => {
  const f = fixture();
  const body = JSON.stringify({ sections:[{ title:'ภาษาไทย', details:{ text:'ไทย🌿'.repeat(240_000) } }] });
  expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(3_000_000);
  const source = vi.fn(async () => { limitD1ReadLeaseUntil(Date.now() + 10_000); return new Response(body, { headers:{ 'content-type':'application/json', 'cache-control':'private, no-store' } }); });
  const wrapped = wrapD1ReadResponseLease(source, profile);
  expect(await (await wrapped(f.req(), f.env, undefined)).text()).toBe(body);
  expect(await (await wrapped(f.req(), f.env, undefined)).text()).toBe(body);
  expect(source).toHaveBeenCalledTimes(1);
});

it('refreshes a valid hit once without waiting and keeps the detached request identity', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  const f = fixture();
  const base = profile.readResponseLease;
  if (!base) throw Error('lease policy missing');
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const source = vi.fn(async (request: Request) => {
    const call = ++calls;
    limitD1ReadLeaseUntil(120_000);
    if (call === 2) {
      expect(request.signal.aborted).toBe(false);
      expect(request.headers.get('cookie')).toBe('session=a');
      expect(request.headers.get('origin')).toBe('https://site.example');
      expect(request.headers.get('cache-control')).toBe('no-cache');
      expect(request.headers.get('x-read-fresh')).toBe('1');
      expect(request.headers.has('if-none-match')).toBe(false);
      await held;
      expect(request.signal.aborted).toBe(false);
    }
    return Response.json({ call });
  });
  const wrapped = wrapD1ReadResponseLease(source, { ...profile, readResponseLease:{ ...base, refreshAheadSeconds:2, freshnessHeader:'x-read-fresh' } });
  await wrapped(f.req(), f.env, undefined);
  vi.setSystemTime(103_000);
  const tasks: Promise<void>[] = [];
  const context = { waitUntil(task: Promise<void>) { tasks.push(task); } };
  const controller = new AbortController();
  const request = new Request(f.req({ 'if-none-match':'"old"' }), { signal:controller.signal });
  expect(await (await wrapped(request, f.env, context)).json()).toEqual({ call:1 });
  controller.abort();
  expect(await (await wrapped(f.req(), f.env, context)).json()).toEqual({ call:1 });
  expect(tasks).toHaveLength(1);
  release?.(); await tasks[0];
  vi.setSystemTime(105_001);
  expect(await (await wrapped(f.req(), f.env, undefined)).json()).toEqual({ call:2 });
  expect(source).toHaveBeenCalledTimes(2);
});

it('keeps old expiry for failed refreshes and never refreshes without waitUntil', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  const f = fixture(); const base = profile.readResponseLease;
  if (!base) throw Error('lease policy missing');
  let calls = 0;
  const source = vi.fn(async () => {
    limitD1ReadLeaseUntil(120_000); calls++;
    if (calls === 2) return new Response(null, { status:304 });
    if (calls === 3) return new Response('bad', { headers:{ 'content-type':'application/json' } });
    return Response.json({ calls });
  });
  const wrapped = wrapD1ReadResponseLease(source, { ...profile, readResponseLease:{ ...base, refreshAheadSeconds:2 } });
  await wrapped(f.req(), f.env, undefined); vi.setSystemTime(103_000);
  await wrapped(f.req(), f.env, undefined);
  expect(calls).toBe(1);
  const tasks: Promise<void>[] = []; const context = { waitUntil(task: Promise<void>) { tasks.push(task); } };
  await wrapped(f.req(), f.env, context); await tasks[0];
  await wrapped(f.req(), f.env, context); await tasks[1];
  expect(await (await wrapped(f.req(), f.env, undefined)).json()).toEqual({ calls:1 });
  vi.setSystemTime(105_000);
  expect(await (await wrapped(f.req(), f.env, undefined)).json()).toEqual({ calls:4 });
});

it('caps refreshed expiry at the new authorization deadline', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  const f = fixture(); const base = profile.readResponseLease;
  if (!base) throw Error('lease policy missing');
  let calls = 0;
  const source = vi.fn(async () => { calls++; limitD1ReadLeaseUntil(calls === 2 ? 106_000 : 120_000); return Response.json({ calls }); });
  const wrapped = wrapD1ReadResponseLease(source, { ...profile, readResponseLease:{ ...base, refreshAheadSeconds:2 } });
  await wrapped(f.req(), f.env, undefined); vi.setSystemTime(103_000);
  const tasks: Promise<void>[] = []; const context = { waitUntil(task: Promise<void>) { tasks.push(task); } };
  await wrapped(f.req(), f.env, context); await tasks[0];
  vi.setSystemTime(105_500); expect(await (await wrapped(f.req(), f.env, undefined)).json()).toEqual({ calls:2 });
  vi.setSystemTime(106_000); expect(await (await wrapped(f.req(), f.env, undefined)).json()).toEqual({ calls:3 });
});

it('does not let an older pending refresh overwrite an explicit fresh response', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  const f = fixture(); const base = profile.readResponseLease;
  if (!base) throw Error('lease policy missing');
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const source = vi.fn(async () => { const call = ++calls; limitD1ReadLeaseUntil(120_000); if (call === 2) await held; return Response.json({ call }); });
  const wrapped = wrapD1ReadResponseLease(source, { ...profile, readResponseLease:{ ...base, refreshAheadSeconds:2, freshnessHeader:'x-read-fresh' } });
  await wrapped(f.req(), f.env, undefined); vi.setSystemTime(103_000);
  const tasks: Promise<void>[] = []; const context = { waitUntil(task: Promise<void>) { tasks.push(task); } };
  await wrapped(f.req(), f.env, context);
  expect(await (await wrapped(f.req({ 'x-read-fresh':'1' }), f.env, context)).json()).toEqual({ call:3 });
  release?.(); await Promise.all(tasks);
  expect(await (await wrapped(f.req(), f.env, undefined)).json()).toEqual({ call:3 });
});

it('rejects invalid refresh-ahead settings', async () => {
  const f = fixture(); const base = profile.readResponseLease;
  if (!base) throw Error('lease policy missing');
  for (const refreshAheadSeconds of [-1, 1.5, 6]) {
    const wrapped = wrapD1ReadResponseLease(f.handler, { ...profile, readResponseLease:{ ...base, refreshAheadSeconds } });
    await wrapped(f.req(), f.env, undefined); await wrapped(f.req(), f.env, undefined);
  }
  expect(f.handler).toHaveBeenCalledTimes(6);
});

it('closes an unsafe background response body and disables windows larger than the active lease', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  const f = fixture(); const base = profile.readResponseLease;
  if (!base) throw Error('lease policy missing');
  let calls = 0; let cancelled = false;
  const source = vi.fn(async () => {
    limitD1ReadLeaseUntil(120_000); calls++;
    if (calls === 3) return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers:{ 'content-type':'text/event-stream' } });
    return Response.json({ calls });
  });
  const tasks: Promise<void>[] = []; const context = { waitUntil(task: Promise<void>) { tasks.push(task); } };
  const invalidWindow = wrapD1ReadResponseLease(source, { ...profile, readResponseLease:{ ...base, maxSeconds:10, refreshAheadSeconds:6 } });
  await invalidWindow(f.req(), f.env, undefined); vi.setSystemTime(104_000);
  await invalidWindow(f.req(), f.env, context);
  expect(tasks).toHaveLength(0);
  const validWindow = wrapD1ReadResponseLease(source, { ...profile, readResponseLease:{ ...base, maxSeconds:10, refreshAheadSeconds:2 } });
  await validWindow(f.req(), f.env, undefined); vi.setSystemTime(108_000);
  await validWindow(f.req(), f.env, context); await tasks[0];
  expect(cancelled).toBe(true);
});

it('accepts optional warmup outside the D1 profile identity', async () => {
  const f = fixture();
  const seen: Array<[string, string | null]> = [];
  const handler = vi.fn(async (request: Request) => {
    seen.push([new URL(request.url).pathname, request.headers.get('x-site-id')]);
    limitD1ReadLeaseUntil(Date.now() + 10000);
    return Response.json({});
  });
  const wrapped = wrapD1ReadResponseLease(handler, profile, { warmup:{ scopeHeader:'x-site-id', catalogScope:'credential', seeds:[{ url:'/items/a', scope:'site-two' }] } });
  const tasks: Promise<unknown>[] = [];
  const context = { waitUntil(task: Promise<unknown>) { tasks.push(task); } };
  await wrapped(f.req({ 'x-site-id':'site-one' }), f.env, context);
  while (tasks.length) await Promise.all(tasks.splice(0));
  expect(seen).toEqual([['/metadata', 'site-one'], ['/items/a', 'site-two']]);
  expect(profile.readResponseLease).not.toHaveProperty('warmup');
});
