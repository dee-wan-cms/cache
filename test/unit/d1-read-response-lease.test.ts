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
  const requests = [new Request('https://test.example/metadata'), f.req({ range:'bytes=0-2' }), f.req({ 'if-none-match':'x' })];
  for (const request of requests) { await f.wrapped(request, f.env, undefined); await f.wrapped(request, f.env, undefined); }
  expect(f.handler).toHaveBeenCalledTimes(6);
  for (const response of [new Response('{}', { status:401, headers:{ 'content-type':'application/json' } }), new Response('{}', { headers:{ 'content-type':'application/json', 'set-cookie':'secret=x' } }), new Response('text'), new Response('{}', { headers:{ 'content-type':'application/json', vary:'X-Unknown' } }), new Response(JSON.stringify({ data:'x'.repeat(8_000_001) }), { headers:{ 'content-type':'application/json' } })]) {
    const load = vi.fn(async () => { limitD1ReadLeaseUntil(Date.now() + 5000); return response.clone(); });
    const wrapped = wrapD1ReadResponseLease(load, profile);
    await wrapped(f.req(), f.env, undefined); await wrapped(f.req(), f.env, undefined);
    expect(load).toHaveBeenCalledTimes(2);
  }
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
  expect(await (await run()).json()).toHaveProperty('calls', 1);
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

it('reuses a multi-megabyte JSON response and rejects oversized encoded envelopes', async () => {
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
  const tooLarge = vi.fn(async () => { limitD1ReadLeaseUntil(Date.now() + 10_000); return new Response(escaped, { headers:{ 'content-type':'application/json' } }); });
  const rejected = wrapD1ReadResponseLease(tooLarge, profile);
  const request = f.req({}, 'https://test.example/metadata?oversize=1');
  await rejected(request, f.env, undefined); await rejected(request, f.env, undefined);
  expect(tooLarge).toHaveBeenCalledTimes(2);
});
