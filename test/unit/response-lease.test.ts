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

it('falls back after a stalled lease lookup and cancels a late response', async () => {
  vi.useFakeTimers();
  let finishMatch: (response: Response) => void = () => {};
  let matchStarted = () => {};
  const late = new Promise<Response>((resolve) => { finishMatch = resolve; });
  const started = new Promise<void>((resolve) => { matchStarted = resolve; });
  const match = vi.spyOn(caches.default, 'match').mockImplementationOnce(() => { matchStarted(); return late; });
  const cancelled = vi.fn();
  try {
    const f = fixture({ ...policy, namespace:'lookup-timeout' });
    const first = f.wrapped(request(), {}, undefined);
    await started;
    await vi.advanceTimersByTimeAsync(100);
    expect(await (await first).json()).toEqual({ count:1 });
    expect(await (await f.wrapped(request(), {}, undefined)).json()).toEqual({ count:1 });
    expect(f.handler).toHaveBeenCalledOnce();
    finishMatch(new Response(new ReadableStream({ cancel:cancelled })));
    await Promise.resolve();
    await Promise.resolve();
    expect(cancelled).toHaveBeenCalledOnce();
  } finally { match.mockRestore(); }
});
it('coalesces simultaneous eligible misses and rereads the filled lease', async () => {
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const handler = vi.fn(async () => { entered?.(); await held; limitReadResponseLeaseUntil(Date.now() + 3000); return Response.json({ value:1 }); });
  const wrapped = wrapReadResponseLease(handler, { ...policy, namespace:'cold-fill' });
  const first = wrapped(request(), {}, undefined);
  await ready;
  const second = wrapped(request(), {}, undefined);
  release?.();
  const responses = await Promise.all([first, second]);
  expect(await Promise.all(responses.map((response) => response.json()))).toEqual([{ value:1 }, { value:1 }]);
  expect(handler).toHaveBeenCalledTimes(1);
});

it('lets a timed-out foreground waiter replace a stalled owner and fill the lease', async () => {
  vi.useFakeTimers();
  let release = () => {};
  let entered = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  let calls = 0;
  const handler = vi.fn(async () => {
    const value = ++calls;
    if (value === 1) { entered(); await held; }
    limitReadResponseLeaseUntil(Date.now() + 5000);
    return Response.json({ value });
  });
  const wrapped = wrapReadResponseLease(handler, { ...policy, namespace:'cold-timeout-replacement' });
  try {
    const first = wrapped(request(), {}, undefined);
    await ready;
    const second = wrapped(request(), {}, undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await (await second).json()).toEqual({ value:2 });
    expect(await (await wrapped(request(), {}, undefined)).json()).toEqual({ value:2 });
    release();
    expect(await (await first).json()).toEqual({ value:1 });
    expect(await (await wrapped(request(), {}, undefined)).json()).toEqual({ value:2 });
    expect(calls).toBe(2);
  } finally { release(); }
});

it('lets a foreground miss replace a background cold owner and rejects its late fill', async () => {
  let releaseWarm = () => {};
  let warmStarted = () => {};
  const heldWarm = new Promise<void>((resolve) => { releaseWarm = resolve; });
  const warmReady = new Promise<void>((resolve) => { warmStarted = resolve; });
  let targetCalls = 0;
  const handler = vi.fn(async (input: Request) => {
    if (new URL(input.url).pathname === '/root') {
      limitReadResponseLeaseUntil(Date.now() + 5000);
      return Response.json({ root:true });
    }
    const value = ++targetCalls;
    if (value === 1) { warmStarted(); await heldWarm; }
    limitReadResponseLeaseUntil(Date.now() + 5000);
    return Response.json({ value });
  });
  const wrapped = wrapReadResponseLease(handler, { ...policy, namespace:'warm-takeover', paths:['/root', '/items'], warmup:{ scopeHeader:'x-site-id', seeds:['/items'] } });
  const jobs: Promise<unknown>[] = [];
  const ctx = { waitUntil(task: Promise<unknown>) { jobs.push(task); } };
  const root = new Request('https://example.test/root', { headers:{ cookie:'session=a', 'x-site-id':'one' } });
  await wrapped(root, {}, ctx);
  await warmReady;
  expect(await (await wrapped(request(), {}, undefined)).json()).toEqual({ value:2 });
  releaseWarm();
  while (jobs.length) await Promise.all(jobs.splice(0));
  expect(await (await wrapped(request(), {}, undefined)).json()).toEqual({ value:2 });
  expect(targetCalls).toBe(2);
});

it('captures an internal warm stream once and replays it for discovery and cache', async () => {
  const paths: string[] = [];
  const clone = vi.fn((): Response => { throw Error('original stream must not be cloned'); });
  const handler = vi.fn(async (input: Request) => {
    const path = new URL(input.url).pathname;
    paths.push(path);
    limitReadResponseLeaseUntil(Date.now() + 5000);
    if (path !== '/seed') return Response.json({ path });
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"next":"/child"}')); controller.close(); },
    }), { headers:{ 'content-type':'application/json' } });
    Object.defineProperty(response, 'clone', { value:clone });
    return response;
  });
  const wrapped = wrapReadResponseLease(handler, {
    ...policy, namespace:'warm-stream-capture', paths:['/root', '/seed', '/child'],
    warmup:{ scopeHeader:'x-site-id', seeds:['/seed'], discover:(url, body) => ({ targets:url.pathname === '/seed' && body && typeof body === 'object' && 'next' in body && body.next === '/child' ? ['/child'] : [] }) },
  });
  const jobs: Promise<unknown>[] = [];
  const ctx = { waitUntil(task: Promise<unknown>) { jobs.push(task); } };
  const req = (path: string) => new Request(`https://example.test${path}`, { headers:{ cookie:'session=a', 'x-site-id':'one' } });
  await wrapped(req('/root'), {}, ctx);
  while (jobs.length) await Promise.all(jobs.splice(0));
  expect(paths).toContain('/child');
  expect(clone).not.toHaveBeenCalled();
  expect(await (await wrapped(req('/seed'), {}, undefined)).json()).toEqual({ next:'/child' });
  expect(paths.filter((path) => path === '/seed')).toHaveLength(1);
});

it('releases the cold owner after an invalid internal warm body', async () => {
  let seedReads = 0;
  const handler = vi.fn(async (input: Request) => {
    limitReadResponseLeaseUntil(Date.now() + 5000);
    if (new URL(input.url).pathname !== '/seed') return Response.json({ root:true });
    seedReads++;
    return seedReads === 1 ? new Response('{', { headers:{ 'content-type':'application/json' } }) : Response.json({ value:2 });
  });
  const wrapped = wrapReadResponseLease(handler, { ...policy, namespace:'warm-invalid-capture', paths:['/root', '/seed'], warmup:{ scopeHeader:'x-site-id', seeds:['/seed'] } });
  const jobs: Promise<unknown>[] = [];
  const ctx = { waitUntil(task: Promise<unknown>) { jobs.push(task); } };
  const req = (path: string) => new Request(`https://example.test${path}`, { headers:{ cookie:'session=a', 'x-site-id':'one' } });
  await wrapped(req('/root'), {}, ctx);
  while (jobs.length) await Promise.all(jobs.splice(0));
  expect(await (await wrapped(req('/seed'), {}, undefined)).json()).toEqual({ value:2 });
  expect(await (await wrapped(req('/seed'), {}, undefined)).json()).toEqual({ value:2 });
  expect(seedReads).toBe(2);
});

it('keeps the replacement owner when the displaced warm request finishes', async () => {
  let releaseWarm = () => {};
  let warmStarted = () => {};
  let releaseForeground = () => {};
  let foregroundStarted = () => {};
  const heldWarm = new Promise<void>((resolve) => { releaseWarm = resolve; });
  const warmReady = new Promise<void>((resolve) => { warmStarted = resolve; });
  const heldForeground = new Promise<void>((resolve) => { releaseForeground = resolve; });
  const foregroundReady = new Promise<void>((resolve) => { foregroundStarted = resolve; });
  let targetCalls = 0;
  const handler = vi.fn(async (input: Request) => {
    if (new URL(input.url).pathname === '/root') {
      limitReadResponseLeaseUntil(Date.now() + 5000);
      return Response.json({ root:true });
    }
    const value = ++targetCalls;
    if (value === 1) { warmStarted(); await heldWarm; }
    if (value === 2) { foregroundStarted(); await heldForeground; }
    limitReadResponseLeaseUntil(Date.now() + 5000);
    return Response.json({ value });
  });
  const wrapped = wrapReadResponseLease(handler, { ...policy, namespace:'warm-takeover-owner', paths:['/root', '/items'], warmup:{ scopeHeader:'x-site-id', seeds:['/items'] } });
  const jobs: Promise<unknown>[] = [];
  const ctx = { waitUntil(task: Promise<unknown>) { jobs.push(task); } };
  const root = new Request('https://example.test/root', { headers:{ cookie:'session=a', 'x-site-id':'one' } });
  await wrapped(root, {}, ctx);
  await warmReady;
  const first = wrapped(request(), {}, undefined);
  await foregroundReady;
  releaseWarm();
  while (jobs.length) await Promise.all(jobs.splice(0));
  const second = wrapped(request(), {}, undefined);
  releaseForeground();
  expect(await Promise.all([first, second].map(async (result) => (await result).json()))).toEqual([{ value:2 }, { value:2 }]);
  expect(targetCalls).toBe(2);
});

it('orders a displaced cache write before the foreground replacement', async () => {
  let releasePut = () => {};
  let putStarted = () => {};
  const heldPut = new Promise<void>((resolve) => { releasePut = resolve; });
  const putReady = new Promise<void>((resolve) => { putStarted = resolve; });
  const put = vi.spyOn(caches.default, 'put').mockImplementation(async (key, response) => {
    const body = await response.clone().json();
    if (body.value === 1) { putStarted(); await heldPut; }
    entries.set(String(key), response.clone());
  });
  try {
    let targetCalls = 0;
    const handler = vi.fn(async (input: Request) => {
      limitReadResponseLeaseUntil(Date.now() + 5000);
      return Response.json(new URL(input.url).pathname === '/root' ? { root:true } : { value:++targetCalls });
    });
    const wrapped = wrapReadResponseLease(handler, { ...policy, namespace:'warm-takeover-put', paths:['/root', '/items'], warmup:{ scopeHeader:'x-site-id', seeds:['/items'] } });
    const jobs: Promise<unknown>[] = [];
    const ctx = { waitUntil(task: Promise<unknown>) { jobs.push(task); } };
    const root = new Request('https://example.test/root', { headers:{ cookie:'session=a', 'x-site-id':'one' } });
    await wrapped(root, {}, ctx);
    await putReady;
    const foreground = wrapped(request(), {}, ctx);
    expect(await (await foreground).json()).toEqual({ value:2 });
    releasePut();
    while (jobs.length) await Promise.all(jobs.splice(0));
    expect(await (await wrapped(request(), {}, undefined)).json()).toEqual({ value:2 });
    expect(targetCalls).toBe(2);
  } finally {
    releasePut();
    put.mockRestore();
  }
});

for (const mode of ['fresh', 'abort'] as const) {
  it(`orders a started cache write before an ${mode} replacement`, async () => {
    let releasePut = () => {};
    let putStarted = () => {};
    const heldPut = new Promise<void>((resolve) => { releasePut = resolve; });
    const putReady = new Promise<void>((resolve) => { putStarted = resolve; });
    const put = vi.spyOn(caches.default, 'put').mockImplementation(async (key, response) => {
      const body = await response.clone().json();
      if (body.value === 1) { putStarted(); await heldPut; }
      entries.set(String(key), response.clone());
    });
    try {
      let calls = 0;
      const handler = vi.fn(async () => {
        limitReadResponseLeaseUntil(Date.now() + 5000);
        return Response.json({ value:++calls });
      });
      const wrapped = wrapReadResponseLease(handler, { ...policy, namespace:`cold-put-${mode}` });
      const jobs: Promise<unknown>[] = [];
      const ctx = { waitUntil(task: Promise<unknown>) { jobs.push(task); } };
      const controller = new AbortController();
      await wrapped(new Request(request(), { signal:controller.signal }), {}, ctx);
      await putReady;
      if (mode === 'abort') controller.abort();
      const replacement = mode === 'fresh' ? request('session=a', 'GET', { 'x-fresh':'1' }) : request();
      expect(await (await wrapped(replacement, {}, ctx)).json()).toEqual({ value:2 });
      if (mode === 'fresh') {
        expect(await (await wrapped(request('session=a', 'GET', { 'x-fresh':'1' }), {}, ctx)).json()).toEqual({ value:3 });
      }
      releasePut();
      while (jobs.length) await Promise.all(jobs.splice(0));
      expect(await (await wrapped(request(), {}, undefined)).json()).toEqual({ value:mode === 'fresh' ? 3 : 2 });
      expect(calls).toBe(mode === 'fresh' ? 3 : 2);
    } finally {
      releasePut();
      put.mockRestore();
    }
  });
}

it('keeps credentials and sites separate and falls back after an uncacheable source', async () => {
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const handler = vi.fn(async () => { entered?.(); await held; return Response.json({ ok:true }); });
  const wrapped = wrapReadResponseLease(handler, { ...policy, namespace:'cold-private' });
  const first = wrapped(request(), {}, undefined);
  await ready;
  const second = wrapped(request(), {}, undefined);
  const otherActor = wrapped(request('session=b'), {}, undefined);
  const otherSite = wrapped(request('session=a', 'GET', { 'x-site-id':'two' }), {}, undefined);
  release?.();
  expect((await Promise.all([first, second, otherActor, otherSite])).map((response) => response.status)).toEqual([200, 200, 200, 200]);
  expect(handler).toHaveBeenCalledTimes(4);
});

it('releases a failed cold source so another request may try', async () => {
  const handler = vi.fn().mockRejectedValueOnce(new Error('source failed')).mockImplementation(async () => Response.json({ ok:true }));
  const wrapped = wrapReadResponseLease(handler, { ...policy, namespace:'cold-throw' });
  await expect(wrapped(request(), {}, undefined)).rejects.toThrow('source failed');
  expect((await wrapped(request(), {}, undefined)).status).toBe(200);
  expect(handler).toHaveBeenCalledTimes(2);
});

it('does not block explicit freshness behind a held cold source', async () => {
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  let freshEntered: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const freshReady = new Promise<void>((resolve) => { freshEntered = resolve; });
  let calls = 0;
  const handler = vi.fn(async () => {
    const value = ++calls;
    if (value === 1) { entered?.(); await held; } else freshEntered?.();
    limitReadResponseLeaseUntil(Date.now() + 3000);
    return Response.json({ value });
  });
  const wrapped = wrapReadResponseLease(handler, { ...policy, namespace:'cold-fresh' });
  const first = wrapped(request(), {}, undefined);
  await ready;
  const fresh = wrapped(request('session=a', 'GET', { 'x-fresh':'1' }), {}, undefined);
  await freshReady;
  expect(await (await fresh).json()).toEqual({ value:2 });
  release?.();
  await first;
  expect(await (await wrapped(request(), {}, undefined)).json()).toEqual({ value:2 });
});

it('does not let a pre-mutation cold fill populate the new generation', async () => {
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  let calls = 0;
  const handler = vi.fn(async (input: Request) => {
    if (input.method !== 'GET') return Response.json({ ok:true });
    const value = ++calls;
    if (value === 1) { entered?.(); await held; }
    limitReadResponseLeaseUntil(Date.now() + 3000);
    return Response.json({ value });
  });
  const wrapped = wrapReadResponseLease(handler, { ...policy, namespace:'cold-mutation' });
  const first = wrapped(request(), {}, undefined);
  await ready;
  const mutation = await wrapped(request('session=a', 'POST'), {}, undefined);
  const generation = mutation.headers.get('set-cookie')?.split(';')[0];
  expect(generation).toMatch(/^fresh=/);
  release?.();
  await first;
  expect(await (await wrapped(request(`session=a; ${generation}`), {}, undefined)).json()).toEqual({ value:2 });
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

it('returns the cached hit while capturing a refresh stream once', async () => {
  vi.useFakeTimers(); vi.setSystemTime(10_000);
  let finishStream = () => {};
  let refreshStarted = () => {};
  const ready = new Promise<void>((resolve) => { refreshStarted = resolve; });
  const clone = vi.fn((): Response => { throw Error('original stream must not be cloned'); });
  let calls = 0;
  const handler = vi.fn(async () => {
    const value = ++calls;
    limitReadResponseLeaseUntil(Date.now() + 5000);
    if (value === 1) return Response.json({ value });
    const response = new Response(new ReadableStream({
      start(controller) {
        finishStream = () => { controller.enqueue(new TextEncoder().encode('{"value":2}')); controller.close(); };
        refreshStarted();
      },
    }), { headers:{ 'content-type':'application/json' } });
    Object.defineProperty(response, 'clone', { value:clone });
    return response;
  });
  const wrapped = wrapReadResponseLease(handler, { ...policy, namespace:'refresh-stream-capture', refreshAheadSeconds:2 });
  const jobs: Promise<unknown>[] = [];
  const ctx = { waitUntil(task: Promise<unknown>) { jobs.push(task); } };
  await wrapped(request(), {}, ctx);
  while (jobs.length) await Promise.all(jobs.splice(0));
  vi.setSystemTime(13_001);
  expect(await (await wrapped(request(), {}, ctx)).json()).toEqual({ value:1 });
  await ready;
  finishStream();
  while (jobs.length) await Promise.all(jobs.splice(0));
  expect(clone).not.toHaveBeenCalled();
  expect(await (await wrapped(request(), {}, undefined)).json()).toEqual({ value:2 });
  expect(calls).toBe(2);
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
