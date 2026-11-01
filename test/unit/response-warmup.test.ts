import { afterEach, expect, it, vi } from 'vitest';
import { limitReadResponseLeaseUntil, wrapReadResponseLease, type ReadResponseLeaseOptions } from '../../src/response-lease';
import { createResponseWarmup } from '../../src/response-warmup';

const entries = new Map<string, Response>();
vi.stubGlobal('caches', { default:{ match:async (key: string) => entries.get(key)?.clone(), put:async (key: string, value: Response) => { entries.set(key, value.clone()); } } });
afterEach(() => { entries.clear(); vi.useRealTimers(); vi.restoreAllMocks(); });
const options: ReadResponseLeaseOptions = { namespace:'warm-tests', deployment:'v1', database:'db', seconds:5, paths:['/api/**'], credentialHeaders:['cookie'], cookieNames:['session', 'fresh'], varyHeaders:['x-site-id'], freshnessCookie:'fresh', freshnessCookieMode:'generation', freshnessHeader:'x-fresh', warmup:{ scopeHeader:'x-site-id', seeds:[] } };
const req = (path: string, cookie = 'session=a', scope: string | null = 'one', extra: Record<string, string> = {}) => new Request(`https://example.test${path}`, { headers:{ cookie, ...(scope ? { 'x-site-id':scope } : {}), ...extra } });
const context = () => {
  const jobs: Promise<unknown>[] = [];
  return { jobs, waitUntil(task: Promise<unknown>) { jobs.push(task); }, async drain() { while (jobs.length) await Promise.all(jobs.splice(0)); } };
};
const driveUntil = async (ready: () => boolean) => {
  for (let turn = 0; turn < 50 && !ready(); turn++) await vi.advanceTimersByTimeAsync(1);
  if (!ready()) throw Error('fake-clock readiness not reached');
};

it('discovers scope from an authorized seed and warms its targets with that scope', async () => {
  const calls: Array<[string, string | null, string | null]> = [];
  const wrapped = wrapReadResponseLease(async (request) => {
    const path = new URL(request.url).pathname;
    calls.push([path, request.headers.get('x-site-id'), request.headers.get('cookie')]);
    limitReadResponseLeaseUntil(Date.now() + 5000);
    return Response.json(path === '/api/layout' ? { scope:'one' } : {});
  }, { ...options, namespace:'discovery', warmup:{ scopeHeader:'x-site-id', seeds:['/api/layout'], discover:(url, body) => url.pathname === '/api/layout' && body && typeof body === 'object' && 'scope' in body && typeof body.scope === 'string' ? { scope:body.scope, targets:['/api/detail'] } : { targets:[] } } });
  const ctx = context();
  await wrapped(req('/api/root', 'session=a', null), {}, ctx); await ctx.drain();
  expect(calls).toEqual([['/api/root', null, 'session=a'], ['/api/layout', null, 'session=a'], ['/api/detail', 'one', 'session=a']]);
});

it('bounds concurrency and unique targets and does not recurse or restart during cooldown', async () => {
  let active = 0, peak = 0;
  let release: (() => void) | undefined;
  let ready: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const twoStarted = new Promise<void>((resolve) => { ready = resolve; });
  const calls: string[] = [];
  const wrapped = wrapReadResponseLease(async (request) => {
    const path = new URL(request.url).pathname;
    calls.push(path);
    if (path !== '/api/root') {
      active++; peak = Math.max(peak, active); if (active === 2) ready?.();
      await blocked; active--;
    }
    limitReadResponseLeaseUntil(Date.now() + 5000);
    return Response.json({});
  }, { ...options, namespace:'bounds', warmup:{ scopeHeader:'x-site-id', seeds:['/api/a', '/api/a', '/api/b', '/api/c', '/api/d'], maxTargets:3, concurrency:2, discover:() => ({ targets:['/api/recursive'] }) } });
  const ctx = context();
  await wrapped(req('/api/root'), {}, ctx); await ctx.jobs[0]; await twoStarted;
  await wrapped(req('/api/root'), {}, ctx);
  release?.(); await ctx.drain();
  expect(peak).toBe(2);
  expect(calls).toEqual(['/api/root', '/api/a', '/api/b', '/api/c']);
});

it('expires catalog entries and cooldown without extending response leases', async () => {
  let now = 100_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const calls: string[] = [];
  const wrapped = wrapReadResponseLease(async (request) => {
    calls.push(`${new URL(request.url).pathname}:${request.headers.get('cookie')}`);
    limitReadResponseLeaseUntil(Date.now() + 5000);
    return Response.json({});
  }, { ...options, namespace:'expiry', warmup:{ scopeHeader:'x-site-id', seeds:[], portable:() => true, catalogTtlMs:1000, cooldownMs:100, maxMilliseconds:100 } });
  const ctx = context();
  await wrapped(req('/api/popular'), {}, ctx); await ctx.drain();
  now += 1001;
  await wrapped(req('/api/other', 'session=b'), {}, ctx); await ctx.drain();
  expect(calls).not.toContain('/api/popular:session=b');
  now += 4000;
  await wrapped(req('/api/popular'), {}, ctx); await ctx.drain();
  expect(calls.filter((call) => call === '/api/popular:session=a')).toHaveLength(2);
});

it('keeps errors and invalid warmup configuration away from the foreground lease', async () => {
  const calls: string[] = [];
  const wrapped = wrapReadResponseLease(async (request) => {
    const path = new URL(request.url).pathname; calls.push(path);
    if (path === '/api/error') throw Error('source failed');
    limitReadResponseLeaseUntil(Date.now() + 5000);
    return Response.json({ path });
  }, { ...options, namespace:'errors', warmup:{ scopeHeader:'x-site-id', seeds:['/api/error', 'https://other.test/api/forbidden', '/api/ok'], concurrency:1, discover:() => { throw Error('discovery failed'); } } });
  const ctx = context();
  expect(await (await wrapped(req('/api/root'), {}, ctx)).json()).toEqual({ path:'/api/root' });
  await ctx.drain();
  expect(calls).toEqual(['/api/root', '/api/error', '/api/ok']);
  expect(await (await wrapped(req('/api/root'), {}, ctx)).json()).toEqual({ path:'/api/root' });
  await ctx.drain();
  const invalid = wrapReadResponseLease(async () => { limitReadResponseLeaseUntil(Date.now() + 5000); return Response.json({ ok:true }); }, { ...options, namespace:'invalid-warm', warmup:{ scopeHeader:'x-site-id', seeds:['/api/ok'], concurrency:0 } });
  expect(await (await invalid(req('/api/root'), {}, ctx)).json()).toEqual({ ok:true }); await ctx.drain();
  expect(await (await invalid(req('/api/root'), {}, ctx)).json()).toEqual({ ok:true });
});

it('isolates warm leases by scope and freshness generation', async () => {
  const calls: string[] = [];
  const wrapped = wrapReadResponseLease(async (request) => {
    calls.push(`${new URL(request.url).pathname}:${request.headers.get('x-site-id')}:${request.headers.get('cookie')}`);
    limitReadResponseLeaseUntil(Date.now() + 5000);
    return Response.json({ scope:request.headers.get('x-site-id'), cookie:request.headers.get('cookie') });
  }, { ...options, namespace:'scope-generation', warmup:{ scopeHeader:'x-site-id', seeds:['/api/sibling'], portable:() => true } });
  const ctx = context();
  await wrapped(req('/api/root'), {}, ctx); await ctx.drain();
  await wrapped(req('/api/root', 'session=a; fresh=12345678-1234-4123-8123-123456789abc', 'two'), {}, ctx); await ctx.drain();
  const fresh = await wrapped(req('/api/sibling', 'session=a; fresh=12345678-1234-4123-8123-123456789abc', 'two'), {}, ctx); await ctx.drain();
  expect(await fresh.json()).toEqual({ scope:'two', cookie:'session=a; fresh=12345678-1234-4123-8123-123456789abc' });
  expect(calls).toContain('/api/sibling:two:session=a; fresh=12345678-1234-4123-8123-123456789abc');
});

it('runs one batch per credential and scope until cooldown expires', async () => {
  let now = 100_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const discover = vi.fn(() => ({ targets:[] }));
  const wrapped = wrapReadResponseLease(async () => {
    limitReadResponseLeaseUntil(Date.now() + 5000);
    return Response.json({ ok:true });
  }, { ...options, namespace:'cooldown', warmup:{ scopeHeader:'x-site-id', seeds:[], discover, cooldownMs:100, maxMilliseconds:100 } });
  const ctx = context();
  await wrapped(req('/api/first'), {}, ctx); await ctx.drain();
  await wrapped(req('/api/second'), {}, ctx); await ctx.drain();
  expect(discover).toHaveBeenCalledTimes(1);
  now += 201;
  await wrapped(req('/api/third'), {}, ctx); await ctx.drain();
  expect(discover).toHaveBeenCalledTimes(2);
});

it('strips freshness and conditional headers while preserving credentials and negotiation', async () => {
  let warmHeaders: Headers | undefined;
  const wrapped = wrapReadResponseLease(async (request) => {
    if (new URL(request.url).pathname === '/api/sibling') warmHeaders = request.headers;
    limitReadResponseLeaseUntil(Date.now() + 5000);
    return Response.json({});
  }, { ...options, namespace:'headers', warmup:{ scopeHeader:'x-site-id', seeds:['/api/sibling'] } });
  const ctx = context();
  await wrapped(req('/api/root', 'session=a', 'one', { 'x-fresh':'1', 'if-none-match':'"old"', 'accept-language':'th', accept:'application/json' }), {}, ctx); await ctx.drain();
  expect(warmHeaders?.get('cookie')).toBe('session=a');
  expect(warmHeaders?.get('x-site-id')).toBe('one');
  expect(warmHeaders?.get('accept-language')).toBe('th');
  expect(warmHeaders?.get('accept')).toBe('application/json');
  expect(warmHeaders?.get('if-none-match')).toBeNull();
});

it('disables warming if the scope header is not part of the lease vary key', async () => {
  const calls: string[] = [];
  const wrapped = wrapReadResponseLease(async (request) => {
    calls.push(new URL(request.url).pathname);
    limitReadResponseLeaseUntil(Date.now() + 5000);
    return Response.json({ ok:true });
  }, { ...options, namespace:'missing-scope-vary', varyHeaders:[], warmup:{ scopeHeader:'x-site-id', seeds:['/api/sibling'] } });
  const ctx = context();
  await wrapped(req('/api/root'), {}, ctx); await ctx.drain();
  await wrapped(req('/api/root'), {}, ctx); await ctx.drain();
  expect(calls).toEqual(['/api/root']);
});

it('warms after the caller consumes the foreground response during its fill', async () => {
  const calls: string[] = [];
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const wrapped = wrapReadResponseLease(async (request) => {
    const path = new URL(request.url).pathname;
    calls.push(path);
    limitReadResponseLeaseUntil(Date.now() + 5000);
    if (path === '/api/root') return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { headers:{ 'content-type':'application/json' } });
    return Response.json({ path });
  }, { ...options, namespace:'consumed-foreground', warmup:{ scopeHeader:'x-site-id', seeds:['/api/sibling'] } });
  const ctx = context();
  const response = await wrapped(req('/api/root'), {}, ctx);
  const foreground = response.json();
  stream?.enqueue(new TextEncoder().encode('{"ok":true}'));
  stream?.close();
  expect(await foreground).toEqual({ ok:true });
  await ctx.drain();
  expect(calls).toEqual(['/api/root', '/api/sibling']);
});

it('records trusted foreground popularity during cooldown for another actor', async () => {
  let now = 100_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const calls: string[] = [];
  const wrapped = wrapReadResponseLease(async (request) => {
    calls.push(`${new URL(request.url).pathname}:${request.headers.get('cookie')}`);
    limitReadResponseLeaseUntil(Date.now() + 5000);
    return Response.json({ actor:request.headers.get('cookie') });
  }, { ...options, namespace:'cooldown-popularity', warmup:{ scopeHeader:'x-site-id', seeds:['/api/seed'], portable:() => true, maxEntries:1 } });
  const ctx = context();
  await wrapped(req('/api/first'), {}, ctx); await ctx.drain();
  for (let visit = 0; visit < 3; visit++) {
    now++;
    await wrapped(req('/api/hot', 'session=a', 'one', { 'x-fresh':'1' }), {}, ctx); await ctx.drain();
  }
  expect(calls.filter((call) => call === '/api/seed:session=a')).toHaveLength(1);
  const stored = await Promise.all([...entries.values()].map(async (response) => response.clone().json()));
  expect(stored).toContainEqual(expect.objectContaining({ value:[expect.objectContaining({ url:'https://example.test/api/hot', count:3 })] }));
  await wrapped(req('/api/other', 'session=b'), {}, ctx); await ctx.drain();
  expect(calls).toContain('/api/hot:session=b');
  expect(await (await wrapped(req('/api/hot', 'session=b'), {}, undefined)).json()).toEqual({ actor:'session=b' });
});

it('runs the scope seed before siblings when scope is missing', async () => {
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const bootstrapStarted = new Promise<void>((resolve) => { started = resolve; });
  const calls: Array<[string, string | null, string | null]> = [];
  const wrapped = wrapReadResponseLease(async (request) => {
    const path = new URL(request.url).pathname;
    calls.push([path, request.headers.get('x-site-id'), request.headers.get('cookie')]);
    if (path === '/api/layout') { started?.(); await blocked; }
    limitReadResponseLeaseUntil(Date.now() + 5000);
    return Response.json(path === '/api/layout' || path === '/api/scoped-root' ? { scope:'one' } : {});
  }, { ...options, namespace:'scope-bootstrap', warmup:{ scopeHeader:'x-site-id', seeds:['/api/sibling', '/api/layout', '/api/layout'], discoverScopeFrom:'/api/layout', discover:(_url, body) => body && typeof body === 'object' && 'scope' in body && typeof body.scope === 'string' ? { scope:body.scope, targets:[] } : { targets:[] } } });
  const ctx = context();
  await wrapped(req('/api/root', 'session=a', null), {}, ctx); await bootstrapStarted;
  expect(calls).toEqual([['/api/root', null, 'session=a'], ['/api/layout', null, 'session=a']]);
  release?.(); await ctx.drain();
  expect(calls).toEqual([['/api/root', null, 'session=a'], ['/api/layout', null, 'session=a'], ['/api/sibling', 'one', 'session=a']]);
  await wrapped(req('/api/scoped-root', 'session=b', null), {}, ctx); await ctx.drain();
  expect(calls).toContainEqual(['/api/sibling', 'one', 'session=b']);
  expect(calls).toContainEqual(['/api/layout', 'one', 'session=b']);
});

it('stops the batch when the scope seed lacks authorization proof or scope', async () => {
  for (const missingProof of [true, false]) {
    const calls: string[] = [];
    const wrapped = wrapReadResponseLease(async (request) => {
      const path = new URL(request.url).pathname; calls.push(path);
      if (path !== '/api/layout' || !missingProof) limitReadResponseLeaseUntil(Date.now() + 5000);
      return Response.json(missingProof && path === '/api/layout' ? { scope:'one' } : {});
    }, { ...options, namespace:`scope-bootstrap-failure-${missingProof}`, warmup:{ scopeHeader:'x-site-id', seeds:['/api/layout', '/api/sibling'], discoverScopeFrom:'/api/layout', discover:(_url, body) => body && typeof body === 'object' && 'scope' in body && typeof body.scope === 'string' ? { scope:body.scope, targets:[] } : { targets:[] } } });
    const ctx = context();
    await wrapped(req('/api/root', 'session=a', null), {}, ctx); await ctx.drain();
    expect(calls).toEqual(['/api/root', '/api/layout']);
  }
});


it('warms the scope seed normally when the request already has scope', async () => {
  const calls: Array<[string, string | null]> = [];
  const wrapped = wrapReadResponseLease(async (request) => {
    calls.push([new URL(request.url).pathname, request.headers.get('x-site-id')]);
    limitReadResponseLeaseUntil(Date.now() + 5000);
    return Response.json({});
  }, { ...options, namespace:'hinted-bootstrap', warmup:{ scopeHeader:'x-site-id', seeds:['/api/layout', '/api/sibling'], discoverScopeFrom:'/api/layout', discover:() => ({ targets:[] }) } });
  const ctx = context();
  await wrapped(req('/api/root'), {}, ctx); await ctx.drain();
  expect(calls).toEqual(expect.arrayContaining([['/api/root', 'one'], ['/api/layout', 'one'], ['/api/sibling', 'one']]));
  expect(calls).toHaveLength(3);
});

it('caps warm source concurrency across actors and scopes', async () => {
  let active = 0, peak = 0;
  let release: (() => void) | undefined;
  let ready: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const twoStarted = new Promise<void>((resolve) => { ready = resolve; });
  const wrapped = wrapReadResponseLease(async (request) => {
    if (new URL(request.url).pathname === '/api/seed') {
      active++; peak = Math.max(peak, active); if (active === 2) ready?.();
      await blocked; active--;
    }
    limitReadResponseLeaseUntil(Date.now() + 5000);
    return Response.json({});
  }, { ...options, namespace:'shared-limit', warmup:{ scopeHeader:'x-site-id', seeds:['/api/seed'], concurrency:2 } });
  const ctx = context();
  await Promise.all(['a', 'b', 'c', 'd'].map((actor, index) => wrapped(req('/api/root', `session=${actor}`, `scope-${index}`), {}, ctx)));
  await twoStarted;
  expect(peak).toBe(2);
  release?.(); await ctx.drain();
  expect(peak).toBe(2);
});

it('drops a queued warm request when its deadline expires', async () => {
  vi.useFakeTimers();
  let release: (() => void) | undefined;
  let ready: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const firstStarted = new Promise<void>((resolve) => { ready = resolve; });
  const calls: string[] = [];
  const wrapped = wrapReadResponseLease(async (request) => {
    if (new URL(request.url).pathname === '/api/seed') { calls.push(request.headers.get('cookie') ?? ''); ready?.(); await blocked; }
    limitReadResponseLeaseUntil(Date.now() + 5000);
    return Response.json({});
  }, { ...options, namespace:'shared-deadline', warmup:{ scopeHeader:'x-site-id', seeds:['/api/seed'], concurrency:1, maxMilliseconds:100 } });
  const ctx = context();
  await wrapped(req('/api/root', 'session=a'), {}, ctx); await ctx.jobs[0]; await driveUntil(() => calls.includes('session=a')); await firstStarted;
  const beforeSecond = ctx.jobs.length;
  await wrapped(req('/api/root', 'session=b'), {}, ctx); await ctx.jobs[beforeSecond];
  await vi.advanceTimersByTimeAsync(101);
  await ctx.drain();
  expect(calls).toEqual(['session=a']);
  release?.();
  vi.useRealTimers();
});

it('cancels semaphore waiters across actors on a successful write', async () => {
  let release: (() => void) | undefined;
  let ready: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const firstStarted = new Promise<void>((resolve) => { ready = resolve; });
  const calls: string[] = [];
  const wrapped = wrapReadResponseLease(async (request) => {
    if (new URL(request.url).pathname === '/api/seed') { calls.push(request.headers.get('cookie') ?? ''); ready?.(); await blocked; }
    limitReadResponseLeaseUntil(Date.now() + 5000);
    return Response.json({});
  }, { ...options, namespace:'shared-cancel', warmup:{ scopeHeader:'x-site-id', seeds:['/api/seed'], concurrency:1 } });
  const ctx = context();
  await wrapped(req('/api/root', 'session=a'), {}, ctx); await firstStarted;
  const beforeSecond = ctx.jobs.length;
  await wrapped(req('/api/root', 'session=b'), {}, ctx);
  await ctx.jobs[beforeSecond];
  await wrapped(new Request('https://example.test/api/write', { method:'POST', headers:{ cookie:'session=a' } }), {}, ctx);
  release?.(); await ctx.drain();
  expect(calls).toEqual(['session=a']);
});

it('retires the lifecycle, cancels queued work and prevents late fills from starting it again', async () => {
  vi.useFakeTimers();
  let releaseWarm: (() => void) | undefined;
  let releaseLate: (() => void) | undefined;
  let warmReady: (() => void) | undefined;
  const blockedWarm = new Promise<void>((resolve) => { releaseWarm = resolve; });
  const blockedLate = new Promise<void>((resolve) => { releaseLate = resolve; });
  const warmStarted = new Promise<void>((resolve) => { warmReady = resolve; });
  let current = true;
  const calls: string[] = [];
  let aborted = false;
  const wrapped = wrapReadResponseLease(async (request) => {
    const path = new URL(request.url).pathname;
    calls.push(`${path}:${request.headers.get('cookie')}`);
    if (path === '/api/seed') {
      request.signal.addEventListener('abort', () => { aborted = true; }, { once:true });
      warmReady?.(); await blockedWarm;
    }
    if (path === '/api/late') await blockedLate;
    limitReadResponseLeaseUntil(Date.now() + 5000);
    return Response.json({ path });
  }, { ...options, namespace:'warm-lifecycle', warmup:{ scopeHeader:'x-site-id', seeds:['/api/seed'], concurrency:1, isCurrent:() => current } });
  const ctx = context();
  await wrapped(req('/api/root', 'session=a'), {}, ctx); await ctx.jobs[0]; await driveUntil(() => calls.includes('/api/seed:session=a')); await warmStarted;
  const beforeSecond = ctx.jobs.length;
  await wrapped(req('/api/root', 'session=b'), {}, ctx); await ctx.jobs[beforeSecond];
  const late = wrapped(req('/api/late', 'session=c'), {}, ctx);
  current = false;
  await vi.advanceTimersByTimeAsync(25);
  expect(aborted).toBe(true);
  releaseLate?.();
  expect(await (await late).json()).toEqual({ path:'/api/late' });
  await ctx.drain();
  expect(calls.filter((call) => call.startsWith('/api/seed:'))).toEqual(['/api/seed:session=a']);
  releaseWarm?.();
  expect(await (await wrapped(req('/api/after', 'session=d'), {}, ctx)).json()).toEqual({ path:'/api/after' });
  await ctx.drain();
  expect(calls.filter((call) => call.startsWith('/api/seed:'))).toEqual(['/api/seed:session=a']);
});

it('keeps the shared slot until an aborted source actually settles', async () => {
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const firstStarted = new Promise<void>((resolve) => { started = resolve; });
  const calls: string[] = [];
  const wrapped = wrapReadResponseLease(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === '/api/seed') {
      const actor = request.headers.get('cookie') ?? '';
      calls.push(actor);
      if (actor === 'session=a') { started?.(); await blocked; }
    }
    limitReadResponseLeaseUntil(Date.now() + 5000);
    return Response.json({ path });
  }, { ...options, namespace:'aborted-source-slot', warmup:{ scopeHeader:'x-site-id', seeds:['/api/seed'], concurrency:1 } });
  const ctx = context();
  await wrapped(req('/api/root', 'session=a'), {}, ctx); await firstStarted;
  await wrapped(new Request('https://example.test/api/write', { method:'POST', headers:{ cookie:'session=a' } }), {}, ctx);
  const beforeSecond = ctx.jobs.length;
  await wrapped(req('/api/root', 'session=b'), {}, ctx); await ctx.jobs[beforeSecond];
  expect(calls).toEqual(['session=a']);
  release?.(); await ctx.drain();
  expect(calls).toEqual(['session=a', 'session=b']);
});

it('waits for an active foreground source before starting the next warm read', async () => {
  vi.useFakeTimers();
  let releaseWarm: (() => void) | undefined;
  let releaseForeground: (() => void) | undefined;
  let warmReady: (() => void) | undefined;
  let foregroundReady: (() => void) | undefined;
  const heldWarm = new Promise<void>((resolve) => { releaseWarm = resolve; });
  const heldForeground = new Promise<void>((resolve) => { releaseForeground = resolve; });
  const warmStarted = new Promise<void>((resolve) => { warmReady = resolve; });
  const foregroundStarted = new Promise<void>((resolve) => { foregroundReady = resolve; });
  const calls: string[] = [];
  const wrapped = wrapReadResponseLease(async (request) => {
    const path = new URL(request.url).pathname; calls.push(path);
    if (path === '/api/first') { warmReady?.(); await heldWarm; }
    if (path === '/api/foreground') { foregroundReady?.(); await heldForeground; }
    limitReadResponseLeaseUntil(Date.now() + 5000);
    return Response.json({ path });
  }, { ...options, namespace:'foreground-priority', warmup:{ scopeHeader:'x-site-id', seeds:['/api/first', '/api/second'], concurrency:1 } });
  const ctx = context();
  await wrapped(req('/api/root'), {}, ctx); await ctx.jobs[0]; await driveUntil(() => calls.includes('/api/first')); await warmStarted;
  const foreground = wrapped(req('/api/foreground'), {}, ctx); await foregroundStarted;
  releaseWarm?.();
  await vi.advanceTimersByTimeAsync(50);
  expect(calls).not.toContain('/api/second');
  releaseForeground?.();
  expect(await (await foreground).json()).toEqual({ path:'/api/foreground' });
  await driveUntil(() => calls.includes('/api/second'));
  await ctx.drain();
  expect(calls.filter((path) => path === '/api/second')).toHaveLength(1);
});


it('disposes owned warmup bodies on discovery, cooldown and invalid configuration', async () => {
  const warm = createResponseWarmup(async () => Response.json({}));
  const make = () => {
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{}')); controller.close(); } }));
    if (!response.body) throw Error('body missing');
    return { response, cancel:vi.spyOn(response.body, 'cancel') };
  };
  const request = req('/api/root');
  const eligible = () => true;
  const first = make();
  await warm.start({ scopeHeader:'x-site-id', seeds:[] }, request, first.response, ['identity'], 'group', eligible, {}, undefined);
  expect(first.cancel).toHaveBeenCalled();
  const cooling = make();
  await warm.start({ scopeHeader:'x-site-id', seeds:[] }, request, cooling.response, ['identity'], 'group', eligible, {}, undefined);
  expect(cooling.cancel).toHaveBeenCalled();
  const invalid = make();
  await warm.start({ scopeHeader:'x-site-id', seeds:[], concurrency:0 }, request, invalid.response, ['identity'], 'invalid', eligible, {}, undefined);
  expect(invalid.cancel).toHaveBeenCalled();
});

it('disposes the warm clone when a source response is invalid JSON', async () => {
  const original = Response.prototype.clone;
  const cancellations: Array<() => number> = [];
  vi.spyOn(Response.prototype, 'clone').mockImplementation(function (this: Response) {
    const copy = original.call(this);
    if (copy.body) { const cancel = vi.spyOn(copy.body, 'cancel'); cancellations.push(() => cancel.mock.calls.length); }
    return copy;
  });
  const wrapped = wrapReadResponseLease(async () => {
    limitReadResponseLeaseUntil(Date.now() + 5000);
    return new Response('invalid json', { headers:{ 'content-type':'application/json' } });
  }, { ...options, namespace:'invalid-body-disposal', warmup:{ scopeHeader:'x-site-id', seeds:['/api/sibling'] } });
  const ctx = context();
  const response = await wrapped(req('/api/root'), {}, ctx);
  expect(await response.text()).toBe('invalid json');
  await ctx.drain();
  expect(cancellations[0]?.()).toBeGreaterThan(0);
});

it('releases the owned body before catalog reads on normal and cooldown paths', async () => {
  const warm = createResponseWarmup(async () => Response.json({}));
  let cancelCalls = 0;
  const observed: number[] = [];
  vi.spyOn(caches.default, 'match').mockImplementation(async () => { observed.push(cancelCalls); return undefined; });
  const make = () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{}')); },
    cancel() { cancelCalls++; },
  }));
  const policy = { scopeHeader:'x-site-id', seeds:[], portable:() => true };
  await warm.start(policy, req('/api/root'), make(), ['identity'], 'catalog-order', () => true, {}, undefined);
  expect(observed.length).toBeGreaterThan(0);
  expect(observed.every((count) => count >= 1)).toBe(true);
  observed.length = 0;
  await warm.start(policy, req('/api/root'), make(), ['identity'], 'catalog-order', () => true, {}, undefined);
  expect(observed.length).toBeGreaterThan(0);
  expect(observed.every((count) => count >= 2)).toBe(true);
});

it('warms a learned scope target ahead of a full seed list after scope bootstrap', async () => {
  const calls: Array<[string, string | null, string | null]> = [];
  const wrapped = wrapReadResponseLease(async (request) => {
    const path = new URL(request.url).pathname;
    calls.push([path, request.headers.get('cookie'), request.headers.get('x-site-id')]);
    limitReadResponseLeaseUntil(Date.now() + 5000);
    return Response.json(path === '/api/layout' ? { scope:'one' } : {});
  }, { ...options, namespace:'hot-before-seeds', warmup:{
    scopeHeader:'x-site-id', seeds:['/api/layout', '/api/seed-one', '/api/seed-two', '/api/seed-three'],
    discoverScopeFrom:'/api/layout', maxTargets:2, concurrency:1,
    discover:(url, body) => url.pathname === '/api/layout' && body && typeof body === 'object' && 'scope' in body && typeof body.scope === 'string' ? { scope:body.scope, targets:[] } : { targets:[] },
    portable:(url) => url.pathname === '/api/hot',
  } });
  const ctx = context();
  await wrapped(req('/api/hot', 'session=a'), {}, ctx); await ctx.drain();
  calls.length = 0;
  await wrapped(req('/api/root', 'session=b', null), {}, ctx); await ctx.drain();
  expect(calls).toEqual([
    ['/api/root', 'session=b', null],
    ['/api/layout', 'session=b', null],
    ['/api/hot', 'session=b', 'one'],
  ]);
  expect(await (await wrapped(req('/api/hot', 'session=b', 'one'), {}, undefined)).json()).toEqual({});
  calls.length = 0;
  await wrapped(req('/api/root', 'session=c', 'one'), {}, ctx); await ctx.drain();
  expect(calls).toEqual([
    ['/api/root', 'session=c', 'one'],
    ['/api/hot', 'session=c', 'one'],
    ['/api/layout', 'session=c', 'one'],
  ]);
});

it('warms identical URLs independently for explicit scopes without changing other headers', async () => {
  const calls: Array<[string, string | null, string | null, string | null]> = [];
  const wrapped = wrapReadResponseLease(async (request) => {
    calls.push([new URL(request.url).pathname, request.headers.get('x-site-id'), request.headers.get('cookie'), request.headers.get('accept-language')]);
    limitReadResponseLeaseUntil(Date.now() + 5000);
    return Response.json({ scope:request.headers.get('x-site-id') });
  }, { ...options, namespace:'multi-scope-targets', warmup:{ scopeHeader:'x-site-id', seeds:[], catalogScope:'credential', discover:(url) => url.pathname === '/api/root' ? { targets:[{ url:'/api/shared', scope:'one' }, { url:'/api/shared', scope:'two' }, { url:'/api/shared', scope:null }, { url:'https://other.test/api/shared', scope:'three' }, { url:'/api/shared', scope:'bad\nvalue' }] } : { targets:[] } } });
  const ctx = context();
  await wrapped(req('/api/root', 'session=a', 'one', { 'accept-language':'th' }), {}, ctx); await ctx.drain();
  expect(calls).toEqual(expect.arrayContaining([
    ['/api/shared', 'one', 'session=a', 'th'], ['/api/shared', 'two', 'session=a', 'th'], ['/api/shared', null, 'session=a', 'th'],
  ]));
  expect(calls).toHaveLength(4);
  for (const scope of ['one', 'two', null]) expect(await (await wrapped(req('/api/shared', 'session=a', scope, { 'accept-language':'th' }), {}, undefined)).json()).toEqual({ scope });
  expect(calls).toHaveLength(4);
});

it('replays credential-private hot scopes in aggregate popularity order before seeds', async () => {
  let now = 100_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const calls: Array<[string, string | null, string | null]> = [];
  const wrapped = wrapReadResponseLease(async (request) => {
    calls.push([new URL(request.url).pathname, request.headers.get('x-site-id'), request.headers.get('cookie')]);
    limitReadResponseLeaseUntil(Date.now() + 5000);
    return Response.json({});
  }, { ...options, namespace:'credential-catalog', varyHeaders:['x-site-id', 'accept-language'], warmup:{ scopeHeader:'x-site-id', catalogScope:'credential', seeds:['/api/seed'], concurrency:1, maxTargets:3, portable:(url) => url.pathname.startsWith('/api/hot-') } });
  const ctx = context();
  for (const [path, scope] of [['/api/hot-a', 'one'], ['/api/hot-b', 'one'], ['/api/hot-c', 'two'], ['/api/hot-c', 'two'], ['/api/hot-c', 'two']] as const) {
    await wrapped(req(path, 'session=a', scope, { 'x-fresh':'1' }), {}, ctx); await ctx.drain();
  }
  now += 5001;
  calls.length = 0;
  await wrapped(req('/api/root', 'session=b', 'three'), {}, ctx); await ctx.drain();
  expect(calls).toEqual([['/api/root', 'three', 'session=b'], ['/api/seed', 'three', 'session=b']]);
  calls.length = 0;
  await wrapped(req('/api/root', 'session=a', 'three'), {}, ctx); await ctx.drain();
  expect(calls.slice(0, 2)).toEqual([['/api/root', 'three', 'session=a'], ['/api/hot-c', 'two', 'session=a']]);
  expect(calls.slice(2)).toEqual(expect.arrayContaining([['/api/hot-a', 'one', 'session=a'], ['/api/hot-b', 'one', 'session=a']]));
  expect(calls).toHaveLength(4);
  calls.length = 0;
  await wrapped(req('/api/root', 'session=a', 'four', { 'accept-language':'th' }), {}, ctx); await ctx.drain();
  expect(calls).toEqual([['/api/root', 'four', 'session=a'], ['/api/seed', 'four', 'session=a']]);
});

it('cancels queued explicit-scope jobs on a successful write', async () => {
  let release: (() => void) | undefined;
  let ready: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const calls: Array<[string, string | null]> = [];
  const wrapped = wrapReadResponseLease(async (request) => {
    const path = new URL(request.url).pathname;
    calls.push([path, request.headers.get('x-site-id')]);
    if (path === '/api/held') { ready?.(); await blocked; }
    limitReadResponseLeaseUntil(Date.now() + 5000);
    return Response.json({});
  }, { ...options, namespace:'scoped-write-cancel', warmup:{ scopeHeader:'x-site-id', catalogScope:'credential', seeds:[{ url:'/api/held', scope:'one' }, { url:'/api/queued', scope:'two' }], concurrency:1 } });
  const ctx = context();
  await wrapped(req('/api/root'), {}, ctx); await started;
  await wrapped(new Request('https://example.test/api/write', { method:'POST', headers:{ cookie:'session=a' } }), {}, ctx);
  release?.(); await ctx.drain();
  expect(calls).toContainEqual(['/api/held', 'one']);
  expect(calls).not.toContainEqual(['/api/queued', 'two']);
});

it('does not fill or start warming when a foreground response completes after a write', async () => {
  let body: ReadableStreamDefaultController<Uint8Array> | undefined;
  const calls: Array<[string, string]> = [];
  let first = true;
  const wrapped = wrapReadResponseLease(async (request) => {
    const path = new URL(request.url).pathname;
    calls.push([request.method, path]);
    if (request.method === 'GET') limitReadResponseLeaseUntil(Date.now() + 5000);
    if (path === '/api/root' && request.method === 'GET' && first) {
      first = false;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }), { headers:{ 'content-type':'application/json' } });
    }
    return Response.json({ path });
  }, { ...options, namespace:'prewrite-foreground', warmup:{ scopeHeader:'x-site-id', seeds:['/api/sibling'] } });
  const ctx = context();
  const old = await wrapped(req('/api/root'), {}, ctx);
  const write = await wrapped(new Request('https://example.test/api/write', { method:'POST', headers:{ cookie:'session=a', 'x-site-id':'one' } }), {}, ctx);
  const fresh = write.headers.get('set-cookie')?.match(/fresh=([^;]+)/)?.[1];
  expect(fresh).toMatch(/^[0-9a-f-]{36}$/);
  body?.enqueue(new TextEncoder().encode('{"path":"/api/root"}')); body?.close();
  expect(await old.json()).toEqual({ path:'/api/root' });
  await ctx.drain();
  expect(calls).toEqual([['GET', '/api/root'], ['POST', '/api/write']]);
  expect(await (await wrapped(req('/api/root'), {}, undefined)).json()).toEqual({ path:'/api/root' });
  expect(await (await wrapped(req('/api/root', `session=a; fresh=${fresh}`), {}, undefined)).json()).toEqual({ path:'/api/root' });
  expect(calls.filter(([method, path]) => method === 'GET' && path === '/api/root')).toHaveLength(3);
});

it('keeps credential popularity across the writer freshness generation without sharing actors or vary values', async () => {
  const calls: Array<[string, string | null, string | null, string | null]> = [];
  const wrapped = wrapReadResponseLease(async (request) => {
    const path = new URL(request.url).pathname;
    calls.push([path, request.headers.get('cookie'), request.headers.get('x-site-id'), request.headers.get('accept-language')]);
    if (request.method === 'GET') limitReadResponseLeaseUntil(Date.now() + 5000);
    return Response.json({ path });
  }, { ...options, namespace:'catalog-writer-generation', varyHeaders:['x-site-id', 'accept-language'], warmup:{ scopeHeader:'x-site-id', catalogScope:'credential', seeds:['/api/seed'], maxTargets:1, concurrency:1, portable:(url) => url.pathname === '/api/hot' } });
  const ctx = context();
  await wrapped(req('/api/hot', 'session=a', 'one', { 'accept-language':'en' }), {}, ctx); await ctx.drain();
  const write = await wrapped(new Request('https://example.test/api/write', { method:'POST', headers:{ cookie:'session=a', 'x-site-id':'one', 'accept-language':'en' } }), {}, ctx);
  const fresh = write.headers.get('set-cookie')?.match(/fresh=([^;]+)/)?.[1];
  expect(fresh).toMatch(/^[0-9a-f-]{36}$/);
  const cookie = `session=a; fresh=${fresh}`;
  calls.length = 0;
  await wrapped(req('/api/root', `session=b; fresh=${fresh}`, 'three', { 'accept-language':'en' }), {}, ctx); await ctx.drain();
  expect(calls.map(([path]) => path)).toEqual(['/api/root', '/api/seed']);
  calls.length = 0;
  await wrapped(req('/api/root', cookie, 'three', { 'accept-language':'th' }), {}, ctx); await ctx.drain();
  expect(calls.map(([path]) => path)).toEqual(['/api/root', '/api/seed']);
  calls.length = 0;
  await wrapped(req('/api/root', cookie, 'three', { 'accept-language':'en' }), {}, ctx); await ctx.drain();
  expect(calls).toEqual([['/api/root', cookie, 'three', 'en'], ['/api/hot', cookie, 'one', 'en']]);
  expect(await (await wrapped(req('/api/hot', cookie, 'one', { 'accept-language':'en' }), {}, undefined)).json()).toEqual({ path:'/api/hot' });
  expect(calls).toHaveLength(2);
});

it('provides all ranked private popular scopes and schedules discovered children after hot URLs', async () => {
  let now = 100_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const contexts: Array<{ scope:string | null; popularScopes:readonly string[] }> = [];
  const calls: string[] = [];
  const wrapped = wrapReadResponseLease(async (request) => {
    calls.push(new URL(request.url).pathname);
    limitReadResponseLeaseUntil(Date.now() + 5000);
    return Response.json({});
  }, { ...options, namespace:'ranked-discovery-context', warmup:{
    scopeHeader:'x-site-id', catalogScope:'credential', discoveryPriority:'next',
    seeds:['/api/cold'], maxTargets:12, maxEntries:32, concurrency:1,
    portable:(url) => url.pathname.startsWith('/api/hot-'),
    discover:(url, _body, context) => {
      if (url.pathname !== '/api/root') return { targets:[] };
      contexts.push(context);
      return { targets:[{ url:'/api/child', scope:'scope-active' }] };
    },
  } });
  const ctx = context();
  for (let index = 0; index < 10; index++) {
    now++;
    await wrapped(req(`/api/hot-${index}`, 'session=a', `scope-${index}`), {}, ctx); await ctx.drain();
  }
  for (let count = 0; count < 2; count++) {
    now++;
    await wrapped(req('/api/hot-9', 'session=a', 'scope-9', { 'x-fresh':'1' }), {}, ctx); await ctx.drain();
  }
  now += 5001; calls.length = 0;
  await wrapped(req('/api/root', 'session=a', 'scope-active'), {}, ctx); await ctx.drain();
  expect(contexts[0]?.scope).toBe('scope-active');
  expect(contexts[0]?.popularScopes).toHaveLength(10);
  expect(contexts[0]?.popularScopes[0]).toBe('scope-9');
  expect(contexts[0]?.popularScopes).toContain('scope-0');
  expect(calls.slice(1, 11).every((path) => path.startsWith('/api/hot-'))).toBe(true);
  expect(calls.slice(11)).toEqual(['/api/child', '/api/cold']);
  await wrapped(req('/api/root', 'session=b', 'scope-other'), {}, ctx); await ctx.drain();
  expect(contexts[1]).toEqual({ scope:'scope-other', popularScopes:[] });
});

it('lets a discovered child replace a queued cold seed within the target budget', async () => {
  const calls: string[] = [];
  const wrapped = wrapReadResponseLease(async (request) => {
    calls.push(new URL(request.url).pathname);
    limitReadResponseLeaseUntil(Date.now() + 5000);
    return Response.json({});
  }, { ...options, namespace:'dynamic-discovery-priority', warmup:{
    scopeHeader:'x-site-id', discoveryPriority:'next', seeds:['/api/first', '/api/cold'], maxTargets:2, concurrency:1,
    discover:(url) => ({ targets:url.pathname === '/api/first' ? ['/api/child'] : [] }),
  } });
  const ctx = context();
  await wrapped(req('/api/root'), {}, ctx); await ctx.drain();
  expect(calls).toEqual(['/api/root', '/api/first', '/api/child']);
});

it('promotes an already queued cold seed when discovery selects it', async () => {
  const calls: string[] = [];
  const wrapped = wrapReadResponseLease(async (request) => {
    calls.push(new URL(request.url).pathname);
    limitReadResponseLeaseUntil(Date.now() + 5000);
    return Response.json({});
  }, { ...options, namespace:'promoted-discovery', warmup:{
    scopeHeader:'x-site-id', discoveryPriority:'next', seeds:['/api/first', '/api/cold', '/api/child'], maxTargets:3, concurrency:1,
    discover:(url) => ({ targets:url.pathname === '/api/first' ? ['/api/child'] : [] }),
  } });
  const ctx = context();
  await wrapped(req('/api/root'), {}, ctx); await ctx.drain();
  expect(calls).toEqual(['/api/root', '/api/first', '/api/child', '/api/cold']);
});

it('keeps the triggering scope in discovery context for a scope-free child', async () => {
  const calls: Array<[string, string | null]> = [];
  const contexts: Array<string | null> = [];
  const wrapped = wrapReadResponseLease(async (request) => {
    calls.push([new URL(request.url).pathname, request.headers.get('x-site-id')]);
    limitReadResponseLeaseUntil(Date.now() + 5000);
    return Response.json({});
  }, { ...options, namespace:'trigger-scope-context', warmup:{
    scopeHeader:'x-site-id', catalogScope:'credential', seeds:[{ url:'/api/sites', scope:null }],
    discover:(url, _body, context) => { if (url.pathname === '/api/sites') contexts.push(context.scope); return { targets:[] }; },
  } });
  const ctx = context();
  await wrapped(req('/api/dashboard', 'session=a', 'site-9'), {}, ctx); await ctx.drain();
  expect(calls).toEqual([['/api/dashboard', 'site-9'], ['/api/sites', null]]);
  expect(contexts).toEqual(['site-9']);
});
