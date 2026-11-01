import { afterEach, expect, it, vi } from 'vitest';
import { cacheReadValue } from '../../src/scoped-read';
import { limitReadResponseLeaseUntil, wrapReadResponseLease, type ReadResponseLeaseOptions } from '../../src/http-response-lease';

const entries = new Map<string, Response>();
vi.stubGlobal('caches', { default:{ match:async (key: string) => entries.get(key)?.clone(), put:async (key: string, value: Response) => { entries.set(key, value.clone()); } } });
afterEach(() => { entries.clear(); vi.useRealTimers(); });
const policy: ReadResponseLeaseOptions = { namespace:'site', deployment:'v1', database:'db1', seconds:5, maxSeconds:5, paths:['/items'], credentialHeaders:['cookie'], cookieNames:['session','fresh'], varyHeaders:['x-site-id'], freshnessCookie:'fresh', freshnessCookieMode:'generation', freshnessHeader:'X-Fresh' };
const request = (cookie = 'session=a', method = 'GET', headers: Record<string,string> = {}) => new Request('https://example.test/items', { method, headers:{ cookie, 'x-site-id':'one', ...headers } });
function fixture(options = policy) {
  let count = 0;
  const handler = vi.fn(async () => { count++; limitReadResponseLeaseUntil(Date.now() + 3000); return Response.json({ count }); });
  return { handler, wrapped:wrapReadResponseLease(handler, options) };
}
it('reuses cache only for the same credentials, site, deployment and database', async () => {
  const a = fixture();
  await a.wrapped(request(), {}, undefined); await a.wrapped(request(), {}, undefined);
  expect(a.handler).toHaveBeenCalledTimes(1);
  await a.wrapped(request('session=b'), {}, undefined);
  await a.wrapped(request('session=a', 'GET', { 'x-site-id':'two' }), {}, undefined);
  expect(a.handler).toHaveBeenCalledTimes(3);
  const b = fixture({ ...policy, deployment:'v2' }); await b.wrapped(request(), {}, undefined);
  const c = fixture({ ...policy, database:'db2' }); await c.wrapped(request(), {}, undefined);
  expect(b.handler).toHaveBeenCalledOnce(); expect(c.handler).toHaveBeenCalledOnce();
});
it('honors the authorization deadline and never fills without proof', async () => {
  vi.useFakeTimers(); vi.setSystemTime(10_000);
  const f = fixture(); await f.wrapped(request(), {}, undefined);
  vi.setSystemTime(12_999); await f.wrapped(request(), {}, undefined); expect(f.handler).toHaveBeenCalledOnce();
  vi.setSystemTime(13_000); await f.wrapped(request(), {}, undefined); expect(f.handler).toHaveBeenCalledTimes(2);
  const noProof = vi.fn(async () => Response.json({ ok:true }));
  const wrapped = wrapReadResponseLease(noProof, { ...policy, namespace:'no-proof' });
  await wrapped(request(), {}, undefined); await wrapped(request(), {}, undefined); expect(noProof).toHaveBeenCalledTimes(2);
});
it('rotates writer generation and fresh headers replace a prior lease', async () => {
  const f = fixture(); await f.wrapped(request(), {}, undefined);
  const write = await f.wrapped(request('session=a', 'POST'), {}, undefined);
  const cookie = write.headers.get('set-cookie')?.split(';')[0]; expect(cookie).toMatch(/^fresh=/);
  await f.wrapped(request(`session=a; ${cookie}`), {}, undefined);
  await f.wrapped(request(`session=a; ${cookie}`), {}, undefined);
  expect(f.handler).toHaveBeenCalledTimes(3);
  await f.wrapped(request('session=a', 'GET', { 'x-fresh':'1' }), {}, undefined);
  await f.wrapped(request(), {}, undefined); expect(f.handler).toHaveBeenCalledTimes(4);
});
it('refreshes ahead in the background and reuses the renewed response', async () => {
  vi.useFakeTimers(); vi.setSystemTime(10_000);
  const f = fixture({ ...policy, refreshAheadSeconds:2 });
  const jobs: Promise<unknown>[] = [];
  const context = { waitUntil(task: Promise<unknown>) { jobs.push(task); } };
  await f.wrapped(request(), {}, context); await Promise.all(jobs.splice(0));
  vi.setSystemTime(11_500);
  await f.wrapped(request(), {}, context); await Promise.all(jobs.splice(0));
  expect(f.handler).toHaveBeenCalledTimes(2);
  vi.setSystemTime(13_001);
  expect(await (await f.wrapped(request(), {}, undefined)).json()).toHaveProperty('count', 2);
  expect(f.handler).toHaveBeenCalledTimes(2);
});

it('caps a standalone response lease at a scoped value hit deadline', async () => {
  vi.useFakeTimers(); vi.setSystemTime(10_000);
  let count = 0;
  const load = vi.fn(async () => ++count);
  const options = { namespace:'summary', key:'actor', validate:(value: unknown): value is number => typeof value === 'number' };
  await cacheReadValue(options, load);
  vi.setSystemTime(14_900);
  const handler = vi.fn(async () => {
    limitReadResponseLeaseUntil(Date.now() + 300_000);
    return Response.json({ value:await cacheReadValue(options, load) });
  });
  const wrapped = wrapReadResponseLease(handler, { ...policy, namespace:'scoped-lease', seconds:300, maxSeconds:300 });
  expect(await (await wrapped(request(), {}, undefined)).json()).toEqual({ value:1 });
  vi.setSystemTime(14_999);
  expect(await (await wrapped(request(), {}, undefined)).json()).toEqual({ value:1 });
  expect(handler).toHaveBeenCalledTimes(1);
  vi.setSystemTime(15_000);
  expect(await (await wrapped(request(), {}, undefined)).json()).toEqual({ value:2 });
  expect(handler).toHaveBeenCalledTimes(2);
  expect(load).toHaveBeenCalledTimes(2);
  vi.setSystemTime(20_000);
  expect(await (await wrapped(request(), {}, undefined)).json()).toEqual({ value:2 });
  expect(handler).toHaveBeenCalledTimes(2);
});
