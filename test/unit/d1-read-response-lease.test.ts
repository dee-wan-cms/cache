import { afterEach, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import type { CacheStore } from '../../src/core/types';
import type { D1CacheProfile } from '../../src/d1/profile';
import { createD1CacheRuntime } from '../../src/d1/env';
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
  for (const response of [new Response('{}', { status:401, headers:{ 'content-type':'application/json' } }), new Response('{}', { headers:{ 'content-type':'application/json', 'set-cookie':'secret=x' } }), new Response('text'), new Response('{}', { headers:{ 'content-type':'application/json', vary:'X-Unknown' } }), new Response(JSON.stringify({ data:'x'.repeat(1_500_001) }), { headers:{ 'content-type':'application/json' } })]) {
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
