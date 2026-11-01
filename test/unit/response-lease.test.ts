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

it('warms eligible siblings once and rejects external targets', async () => {
  const calls: string[] = [];
  const handler = vi.fn(async (req: Request) => {
    calls.push(new URL(req.url).pathname);
    limitReadResponseLeaseUntil(Date.now() + 5000);
    return Response.json({ path:new URL(req.url).pathname });
  });
  const wrapped = wrapReadResponseLease(handler, { ...policy, namespace:'warm-siblings', paths:['/api/**'], warmup:{ scopeHeader:'x-site-id', seeds:['/api/sibling', '/api/sibling', 'https://elsewhere.test/api/bad'], maxTargets:4 } });
  const jobs: Promise<unknown>[] = [];
  const ctx = { waitUntil(task: Promise<unknown>) { jobs.push(task); } };
  const req = (path: string) => new Request(`https://example.test${path}`, { headers:{ cookie:'session=a', 'x-site-id':'one' } });
  await wrapped(req('/api/first'), {}, ctx);
  while (jobs.length) await Promise.all(jobs.splice(0));
  expect(calls).toEqual(['/api/first', '/api/sibling']);
  await wrapped(req('/api/sibling'), {}, ctx);
  while (jobs.length) await Promise.all(jobs.splice(0));
  expect(calls).toEqual(['/api/first', '/api/sibling']);
});

it('replays portable URLs with the current actor credentials', async () => {
  const calls: string[] = [];
  const handler = vi.fn(async (req: Request) => {
    calls.push(`${new URL(req.url).pathname}:${req.headers.get('cookie')}`);
    limitReadResponseLeaseUntil(Date.now() + 5000);
    return Response.json({ actor:req.headers.get('cookie') });
  });
  const options: ReadResponseLeaseOptions = { ...policy, namespace:'warm-catalog', paths:['/api/**'], warmup:{ scopeHeader:'x-site-id', seeds:[], portable:() => true } };
  const wrapped = wrapReadResponseLease(handler, options);
  const jobs: Promise<unknown>[] = [];
  const ctx = { waitUntil(task: Promise<unknown>) { jobs.push(task); } };
  const req = (path: string, actor: string) => new Request(`https://example.test${path}`, { headers:{ cookie:`session=${actor}`, 'x-site-id':'one' } });
  await wrapped(req('/api/popular', 'a'), {}, ctx);
  while (jobs.length) await Promise.all(jobs.splice(0));
  await wrapped(req('/api/other', 'b'), {}, ctx);
  while (jobs.length) await Promise.all(jobs.splice(0));
  expect(calls).toContain('/api/popular:session=b');
  expect(await (await wrapped(req('/api/popular', 'b'), {}, undefined)).json()).toEqual({ actor:'session=b' });
});

it('requires authorization proof before scheduling warmup', async () => {
  const handler = vi.fn(async () => Response.json({ ok:true }));
  const wrapped = wrapReadResponseLease(handler, { ...policy, namespace:'warm-no-proof', paths:['/api/**'], warmup:{ scopeHeader:'x-site-id', seeds:['/api/sibling'] } });
  const jobs: Promise<unknown>[] = [];
  const context = { waitUntil(task: Promise<unknown>) { jobs.push(task); } };
  await wrapped(new Request('https://example.test/api/first', { headers:{ cookie:'session=a', 'x-site-id':'one' } }), {}, context);
  while (jobs.length) await Promise.all(jobs.splice(0));
  expect(handler).toHaveBeenCalledOnce();
});

it('cancels queued warm reads after a successful write', async () => {
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const warmStarted = new Promise<void>((resolve) => { started = resolve; });
  const calls: string[] = [];
  const handler = vi.fn(async (req: Request) => {
    const path = new URL(req.url).pathname;
    calls.push(`${req.method}:${path}`);
    if (path === '/api/held' && req.method === 'GET') { started?.(); await blocked; }
    limitReadResponseLeaseUntil(Date.now() + 5000);
    return Response.json({ path });
  });
  const wrapped = wrapReadResponseLease(handler, { ...policy, namespace:'warm-cancel', paths:['/api/**'], warmup:{ scopeHeader:'x-site-id', seeds:['/api/held', '/api/queued'], concurrency:1 } });
  const jobs: Promise<unknown>[] = [];
  const ctx = { waitUntil(task: Promise<unknown>) { jobs.push(task); } };
  const req = (path: string, method = 'GET') => new Request(`https://example.test${path}`, { method, headers:{ cookie:'session=a', 'x-site-id':'one' } });
  await wrapped(req('/api/first'), {}, ctx);
  await warmStarted;
  const write = await wrapped(req('/api/write', 'POST'), {}, ctx);
  expect(write.headers.get('set-cookie')).toMatch(/^fresh=/);
  release?.();
  while (jobs.length) await Promise.all(jobs.splice(0));
  expect(calls).not.toContain('GET:/api/queued');
  await wrapped(req('/api/held'), {}, undefined);
  expect(calls.filter((call) => call === 'GET:/api/held')).toHaveLength(2);
});

it.each([
  { path:'/api/presence/entry', status:200 },
  { path:'/api/working-drafts/entry', status:200 },
  { path:'/api/content/entry/preview', status:200 },
  { path:'/api/write', status:500 },
])('keeps queued warm reads after $path returns $status', async ({ path, status }) => {
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const warmStarted = new Promise<void>((resolve) => { started = resolve; });
  const calls: string[] = [];
  const handler = vi.fn(async (req: Request) => {
    const target = new URL(req.url).pathname;
    calls.push(`${req.method}:${target}`);
    if (target === '/api/held' && req.method === 'GET') { started?.(); await blocked; }
    limitReadResponseLeaseUntil(Date.now() + 5000);
    return Response.json({ path:target }, { status:req.method === 'POST' ? status : 200 });
  });
  const wrapped = wrapReadResponseLease(handler, {
    ...policy,
    namespace:`warm-excluded-${path}-${status}`,
    paths:['/api/**'],
    freshnessCookieExcludedPaths:['/api/presence/*', '/api/working-drafts/*', '/api/content/*/preview'],
    warmup:{ scopeHeader:'x-site-id', seeds:['/api/held', '/api/queued'], concurrency:1 },
  });
  const jobs: Promise<unknown>[] = [];
  const ctx = { waitUntil(task: Promise<unknown>) { jobs.push(task); } };
  const req = (target: string, method = 'GET') => new Request(`https://example.test${target}`, { method, headers:{ cookie:'session=a', 'x-site-id':'one' } });
  await wrapped(req('/api/first'), {}, ctx);
  await warmStarted;
  try {
    const response = await wrapped(req(path, 'POST'), {}, ctx);
    expect(response.status).toBe(status);
    expect(response.headers.has('set-cookie')).toBe(false);
  } finally {
    release?.();
  }
  while (jobs.length) await Promise.all(jobs.splice(0));
  expect(calls).toContain('GET:/api/queued');
  await wrapped(req('/api/held'), {}, undefined);
  expect(calls.filter((call) => call === 'GET:/api/held')).toHaveLength(1);
});
