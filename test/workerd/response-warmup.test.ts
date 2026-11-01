import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { resolve } from 'node:path';

const source = `
import { wrapReadResponseLease, limitReadResponseLeaseUntil } from './response-lease';
const calls = [];
const wrapped = wrapReadResponseLease(async request => {
  const url = new URL(request.url);
  calls.push([url.pathname, request.headers.get('cookie'), request.headers.get('x-site-id')]);
  limitReadResponseLeaseUntil(Date.now() + 10000);
  return Response.json({ path:url.pathname, actor:request.headers.get('cookie'), site:request.headers.get('x-site-id') });
}, { namespace:'native-warm', deployment:'v1', database:'db', seconds:5, paths:['/api/**'], credentialHeaders:['cookie'], cookieNames:['session', 'fresh'], varyHeaders:['x-site-id'], freshnessCookie:'fresh', freshnessCookieMode:'generation', warmup:{ scopeHeader:'x-site-id', seeds:['/api/sibling'], portable:() => true } });
export default { async fetch(request, env) {
  if (new URL(request.url).pathname === '/calls') return Response.json(calls);
  const jobs = [];
  const context = { waitUntil(task) { jobs.push(task); } };
  const response = await wrapped(request, env, context);
  while (jobs.length) await Promise.all(jobs.splice(0));
  return response;
} };`;

it('warms native Cache API entries and replays portable URLs using the current actor', async () => {
  const bundle = await build({ stdin:{ contents:source, resolveDir:resolve(__dirname, '../../src'), loader:'ts' }, bundle:true, format:'esm', platform:'neutral', target:'es2022', external:['cloudflare:workers', 'node:async_hooks'], write:false });
  const output = bundle.outputFiles[0];
  if (!output) throw Error('bundle missing');
  const worker = new Miniflare({ modules:true, script:output.text, compatibilityDate:'2026-01-01', compatibilityFlags:['nodejs_compat'] });
  try {
    const fetch = (path: string, actor: string, site = 'one') => worker.dispatchFetch(`https://cache.test${path}`, { headers:{ cookie:`session=${actor}`, 'x-site-id':site } });
    expect(await (await fetch('/api/hot', 'a')).json()).toEqual({ path:'/api/hot', actor:'session=a', site:'one' });
    expect(await (await fetch('/api/sibling', 'a')).json()).toEqual({ path:'/api/sibling', actor:'session=a', site:'one' });
    expect(await (await fetch('/api/root', 'b')).json()).toEqual({ path:'/api/root', actor:'session=b', site:'one' });
    expect(await (await fetch('/api/hot', 'b')).json()).toEqual({ path:'/api/hot', actor:'session=b', site:'one' });
    expect(await (await fetch('/api/hot', 'b', 'two')).json()).toEqual({ path:'/api/hot', actor:'session=b', site:'two' });
    const calls: unknown = await (await worker.dispatchFetch('https://cache.test/calls')).json();
    expect(calls).toEqual(expect.arrayContaining([['/api/hot', 'session=a', 'one'], ['/api/sibling', 'session=a', 'one'], ['/api/hot', 'session=b', 'one'], ['/api/hot', 'session=b', 'two']]));
    expect(Array.isArray(calls) && calls.filter((call) => Array.isArray(call) && call[0] === '/api/sibling' && call[1] === 'session=a')).toHaveLength(1);
  } finally { await worker.dispose(); }
});

const overlapSource = `
import { wrapReadResponseLease, limitReadResponseLeaseUntil } from './response-lease';
let holding = true, current = true, active = 0, peak = 0;
const calls = [], discovered = [];
const wrapped = wrapReadResponseLease(async request => {
  const path = new URL(request.url).pathname, actor = request.headers.get('cookie');
  calls.push([path, actor]);
  if (path === '/api/seed' && request.method === 'GET') {
    active++; peak = Math.max(peak, active);
    try { while (holding && !request.signal.aborted) await new Promise(resolve => setTimeout(resolve, 10)); }
    finally { active--; }
  }
  limitReadResponseLeaseUntil(Date.now() + 10000);
  return Response.json({ path, actor });
}, { namespace:'overlap-native', deployment:'v1', database:'db', seconds:5, paths:['/api/**'], credentialHeaders:['cookie'], cookieNames:['session', 'fresh'], varyHeaders:['x-site-id'], freshnessCookie:'fresh', freshnessCookieMode:'generation', warmup:{ scopeHeader:'x-site-id', seeds:['/api/seed'], concurrency:1, isCurrent:() => current, discover:(url, body) => { if (url.pathname === '/api/root') discovered.push(body.actor); return { targets:[] }; } } });
export default { async fetch(request, env) {
  const path = new URL(request.url).pathname;
  if (path === '/state') return Response.json({ calls, discovered, active, peak });
  if (path === '/release') { holding = false; return new Response('ok'); }
  if (path === '/hold') { holding = true; return new Response('ok'); }
  if (path === '/retire') { current = false; return new Response('ok'); }
  const jobs = [];
  const ctx = { waitUntil(task) { jobs.push(task); } };
  const response = await wrapped(request, env, ctx);
  while (jobs.length) await Promise.all(jobs.splice(0));
  return response;
} };`;

it('shares the limit and cancels work across overlapping native request contexts', async () => {
  const bundle = await build({ stdin:{ contents:overlapSource, resolveDir:resolve(__dirname, '../../src'), loader:'ts' }, bundle:true, format:'esm', platform:'neutral', target:'es2022', external:['cloudflare:workers', 'node:async_hooks'], write:false });
  const output = bundle.outputFiles[0];
  if (!output) throw Error('bundle missing');
  const worker = new Miniflare({ modules:true, script:output.text, compatibilityDate:'2026-01-01', compatibilityFlags:['nodejs_compat'] });
  try {
    const fetch = (path: string, actor: string, method = 'GET') => worker.dispatchFetch(`https://cache.test${path}`, { method, headers:{ cookie:`session=${actor}`, 'x-site-id':'one' } });
    const state = async () => (await (await worker.dispatchFetch('https://cache.test/state')).json()) as { calls: string[][]; discovered: string[]; active: number; peak: number };
    const until = async (predicate: (value: Awaited<ReturnType<typeof state>>) => boolean) => {
      for (let attempt = 0; attempt < 200; attempt++) { const value = await state(); if (predicate(value)) return value; }
      throw Error('worker readiness not reached');
    };
    const first = fetch('/api/root', 'a');
    await until((value) => value.active === 1);
    const second = fetch('/api/root', 'b');
    const both = await until((value) => value.discovered.includes('session=b'));
    expect(both.peak).toBe(1);
    expect(both.calls.filter(([path]) => path === '/api/seed')).toEqual([['/api/seed', 'session=a']]);
    await worker.dispatchFetch('https://cache.test/release');
    expect(await (await first).json()).toMatchObject({ actor:'session=a' });
    expect(await (await second).json()).toMatchObject({ actor:'session=b' });
    expect(await (await fetch('/api/seed', 'a')).json()).toMatchObject({ actor:'session=a' });
    expect(await (await fetch('/api/seed', 'b')).json()).toMatchObject({ actor:'session=b' });
    const after = await state();
    expect(after.peak).toBe(1);
    expect(after.calls.filter(([path]) => path === '/api/seed')).toEqual([['/api/seed', 'session=a'], ['/api/seed', 'session=b']]);
    await worker.dispatchFetch('https://cache.test/hold');
    const third = fetch('/api/root', 'c');
    await until((value) => value.active === 1);
    const fourth = fetch('/api/root', 'd');
    await until((value) => value.discovered.includes('session=d'));
    expect((await fetch('/api/write', 'c', 'POST')).status).toBe(200);
    await worker.dispatchFetch('https://cache.test/retire');
    await worker.dispatchFetch('https://cache.test/release');
    expect((await third).status).toBe(200);
    expect((await fourth).status).toBe(200);
    expect((await state()).calls).not.toContainEqual(['/api/seed', 'session=d']);
  } finally { await worker.dispose(); }
});

const foregroundSource = `
import { wrapReadResponseLease, limitReadResponseLeaseUntil } from './response-lease';
let holding = true, started = 0;
const roots = {};
const wrapped = wrapReadResponseLease(async (request, env) => {
  const path = new URL(request.url).pathname;
  if (path === '/api/root') { const actor = request.headers.get('cookie'); roots[actor] = (roots[actor] ?? 0) + 1; }
  if (path === '/api/seed') {
    started++;
    while (holding && !request.signal.aborted) await new Promise(resolve => setTimeout(resolve, 10));
  }
  const row = await env.DB.prepare('SELECT 1 AS value').first();
  limitReadResponseLeaseUntil(Date.now() + 10000);
  return Response.json({ actor:request.headers.get('cookie'), value:row.value });
}, { namespace:'foreground-native', deployment:'v1', database:'db', seconds:5, paths:['/api/**'], credentialHeaders:['cookie'], cookieNames:['session', 'fresh'], varyHeaders:['x-site-id'], freshnessCookie:'fresh', freshnessCookieMode:'generation', warmup:{ scopeHeader:'x-site-id', seeds:['/api/seed'], concurrency:1 } });
export default { fetch(request, env, context) {
  const path = new URL(request.url).pathname;
  if (path === '/state') return Response.json({ started, roots });
  if (path === '/release') { holding = false; return new Response('ok'); }
  return wrapped(request, env, context);
} };`;

it('returns native foreground responses while another request owns a held warm read', async () => {
  const bundle = await build({ stdin:{ contents:foregroundSource, resolveDir:resolve(__dirname, '../../src'), loader:'ts' }, bundle:true, format:'esm', platform:'neutral', target:'es2022', external:['cloudflare:workers', 'node:async_hooks'], write:false });
  const output = bundle.outputFiles[0];
  if (!output) throw Error('bundle missing');
  const worker = new Miniflare({ modules:true, script:output.text, compatibilityDate:'2026-01-01', compatibilityFlags:['nodejs_compat'], d1Databases:['DB'] });
  const fetch = (actor: string) => worker.dispatchFetch('https://cache.test/api/root', { headers:{ cookie:`session=${actor}`, 'x-site-id':'one' } });
  const within = async <T>(task: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([task, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('foreground response did not return')), 3000); })]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  };
  try {
    const first = await within(fetch('a'));
    expect(await within(first.json())).toEqual({ actor:'session=a', value:1 });
    let started = false;
    for (let attempt = 0; attempt < 200 && !started; attempt++) {
      const state: unknown = await (await worker.dispatchFetch('https://cache.test/state')).json();
      started = !!state && typeof state === 'object' && Reflect.get(state, 'started') === 1;
    }
    expect(started).toBe(true);
    const rootCount = async () => {
      const state: unknown = await (await worker.dispatchFetch('https://cache.test/state')).json();
      const roots: unknown = state && typeof state === 'object' ? Reflect.get(state, 'roots') : null;
      return roots && typeof roots === 'object' ? Reflect.get(roots, 'session=a') : undefined;
    };
    let hits = 0;
    for (let attempt = 0; attempt < 10 && hits < 3; attempt++) {
      const before = await rootCount();
      expect(await within((await within(fetch('a'))).json())).toEqual({ actor:'session=a', value:1 });
      const after = await rootCount();
      hits = typeof before === 'number' && before === after ? hits + 1 : 0;
    }
    expect(hits).toBe(3);
    const second = await within(fetch('b'));
    expect(await within(second.json())).toEqual({ actor:'session=b', value:1 });
    const state: unknown = await (await worker.dispatchFetch('https://cache.test/state')).json();
    expect(state).toMatchObject({ started:1 });
  } finally {
    await worker.dispatchFetch('https://cache.test/release');
    await worker.dispose();
  }
});

it('returns foreground HTTP responses and cache hits while a warm read is held', async () => {
  const bundle = await build({ stdin:{ contents:foregroundSource, resolveDir:resolve(__dirname, '../../src'), loader:'ts' }, bundle:true, format:'esm', platform:'neutral', target:'es2022', external:['cloudflare:workers', 'node:async_hooks'], write:false });
  const output = bundle.outputFiles[0];
  if (!output) throw Error('bundle missing');
  const worker = new Miniflare({ modules:true, script:output.text, compatibilityDate:'2026-01-01', compatibilityFlags:['nodejs_compat'], d1Databases:['DB'] });
  const base = await worker.ready;
  const fetchPath = (path: string, actor?: string) => fetch(new URL(path, base), { headers:actor ? { cookie:`session=${actor}`, 'x-site-id':'one' } : {} });
  const within = async <T>(task: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([task, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('HTTP foreground response did not return')), 3000); })]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const state = async () => {
    const value: unknown = await (await within(fetchPath('/state'))).json();
    if (!value || typeof value !== 'object') throw Error('invalid worker state');
    return value;
  };
  const count = (value: object) => {
    const roots: unknown = Reflect.get(value, 'roots');
    return roots && typeof roots === 'object' ? Reflect.get(roots, 'session=a') : undefined;
  };
  try {
    expect(await within((await within(fetchPath('/api/root', 'a'))).json())).toEqual({ actor:'session=a', value:1 });
    let ready = false;
    for (let attempt = 0; attempt < 200 && !ready; attempt++) ready = Reflect.get(await state(), 'started') === 1;
    expect(ready).toBe(true);
    let hits = 0;
    for (let attempt = 0; attempt < 10 && hits < 3; attempt++) {
      const before = count(await state());
      expect(await within((await within(fetchPath('/api/root', 'a'))).json())).toEqual({ actor:'session=a', value:1 });
      const after = count(await state());
      hits = typeof before === 'number' && before === after ? hits + 1 : 0;
    }
    expect(hits).toBe(3);
    expect(await within((await within(fetchPath('/api/root', 'b'))).json())).toEqual({ actor:'session=b', value:1 });
    expect(Reflect.get(await state(), 'started')).toBe(1);
  } finally {
    await fetchPath('/release');
    await worker.dispose();
  }
});

const fairBatchSource = `
import { wrapReadResponseLease, limitReadResponseLeaseUntil } from './response-lease';
let completed = 0;
const wrapped = wrapReadResponseLease(async (request, env) => {
  const path = new URL(request.url).pathname;
  if (path.startsWith('/api/seed/')) {
    for (let index = 0; index < 4; index++) await env.DB.prepare('SELECT 1 AS value').first();
    completed++;
  }
  limitReadResponseLeaseUntil(Date.now() + 10000);
  return Response.json({ path, completed });
}, { namespace:'fair-native-http', deployment:'v1', database:'db', seconds:5, paths:['/api/**'], credentialHeaders:['cookie'], cookieNames:['session', 'fresh'], varyHeaders:['x-site-id'], freshnessCookie:'fresh', freshnessCookieMode:'generation', warmup:{ scopeHeader:'x-site-id', seeds:Array.from({ length:64 }, (_, index) => '/api/seed/' + index), maxTargets:64, concurrency:1 } });
export default { fetch(request, env, context) {
  if (new URL(request.url).pathname === '/state') return Response.json({ completed });
  return wrapped(request, env, context);
} };`;

it('lets real HTTP foreground requests run before a fast warm batch completes', async () => {
  const bundle = await build({ stdin:{ contents:fairBatchSource, resolveDir:resolve(__dirname, '../../src'), loader:'ts' }, bundle:true, format:'esm', platform:'neutral', target:'es2022', external:['cloudflare:workers', 'node:async_hooks'], write:false });
  const output = bundle.outputFiles[0];
  if (!output) throw Error('bundle missing');
  const worker = new Miniflare({ modules:true, script:output.text, compatibilityDate:'2026-01-01', compatibilityFlags:['nodejs_compat'], d1Databases:['DB'] });
  const base = await worker.ready;
  const request = (path: string, actor?: string) => fetch(new URL(path, base), { headers:actor ? { cookie:`session=${actor}`, 'x-site-id':'one' } : {} });
  const within = async <T>(task: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([task, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('HTTP fairness deadline')), 3000); })]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  };
  try {
    expect(await within((await within(request('/api/root', 'a'))).json())).toMatchObject({ path:'/api/root' });
    let count = 0;
    for (let attempt = 0; attempt < 200 && count === 0; attempt++) {
      const state: unknown = await within((await within(request('/state'))).json());
      const value: unknown = state && typeof state === 'object' ? Reflect.get(state, 'completed') : undefined;
      if (typeof value === 'number') count = value;
    }
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(64);
    const second: unknown = await within((await within(request('/api/other', 'b'))).json());
    expect(second).toMatchObject({ path:'/api/other' });
    const completed: unknown = second && typeof second === 'object' ? Reflect.get(second, 'completed') : undefined;
    expect(completed).toBeTypeOf('number');
    expect(completed).toBeLessThan(64);
  } finally { await worker.dispose(); }
});

const multiScopeSource = `
import { wrapReadResponseLease, limitReadResponseLeaseUntil } from './response-lease';
let now = Date.now();
Date.now = () => now;
const calls = [];
const wrapped = wrapReadResponseLease(async request => {
  const path = new URL(request.url).pathname;
  const actor = request.headers.get('cookie'), scope = request.headers.get('x-site-id');
  calls.push([path, actor, scope]);
  limitReadResponseLeaseUntil(Date.now() + 10000);
  return Response.json({ path, actor, scope });
}, { namespace:'multi-scope-native', deployment:'v1', database:'db', seconds:5, paths:['/api/**'], credentialHeaders:['cookie'], cookieNames:['session', 'fresh'], varyHeaders:['x-site-id'], freshnessCookie:'fresh', freshnessCookieMode:'generation', warmup:{ scopeHeader:'x-site-id', catalogScope:'credential', seeds:[], portable:url => url.pathname === '/api/hot', discover:url => url.pathname === '/api/root' ? { targets:[{ url:'/api/shared', scope:'one' }, { url:'/api/shared', scope:'two' }] } : { targets:[] } } });
export default { async fetch(request, env) {
  const path = new URL(request.url).pathname;
  if (path === '/calls') return Response.json(calls);
  if (path === '/advance') { now += 6000; return new Response('ok'); }
  const jobs = [];
  const context = { waitUntil(task) { jobs.push(task); } };
  const response = await wrapped(request, env, context);
  while (jobs.length) await Promise.all(jobs.splice(0));
  return response;
} };`;

it('replays credential-private scoped targets through the native Cache API', async () => {
  const bundle = await build({ stdin:{ contents:multiScopeSource, resolveDir:resolve(__dirname, '../../src'), loader:'ts' }, bundle:true, format:'esm', platform:'neutral', target:'es2022', external:['cloudflare:workers', 'node:async_hooks'], write:false });
  const output = bundle.outputFiles[0];
  if (!output) throw Error('bundle missing');
  const worker = new Miniflare({ modules:true, script:output.text, compatibilityDate:'2026-01-01', compatibilityFlags:['nodejs_compat'] });
  try {
    const fetch = (path: string, actor: string, scope: string) => worker.dispatchFetch(`https://cache.test${path}`, { headers:{ cookie:`session=${actor}`, 'x-site-id':scope } });
    await fetch('/api/hot', 'a', 'two');
    await worker.dispatchFetch('https://cache.test/advance');
    expect(await (await fetch('/api/root', 'a', 'one')).json()).toMatchObject({ actor:'session=a', scope:'one' });
    for (const scope of ['one', 'two']) {
      expect(await (await fetch('/api/shared', 'a', scope)).json()).toEqual({ path:'/api/shared', actor:'session=a', scope });
    }
    expect(await (await fetch('/api/hot', 'a', 'two')).json()).toEqual({ path:'/api/hot', actor:'session=a', scope:'two' });
    expect(await (await fetch('/api/root', 'b', 'one')).json()).toMatchObject({ actor:'session=b', scope:'one' });
    expect(await (await fetch('/api/shared', 'b', 'two')).json()).toEqual({ path:'/api/shared', actor:'session=b', scope:'two' });
    const calls: unknown = await (await worker.dispatchFetch('https://cache.test/calls')).json();
    expect(Array.isArray(calls)).toBe(true);
    if (!Array.isArray(calls)) throw Error('invalid calls');
    expect(calls.filter((call) => Array.isArray(call) && call[0] === '/api/shared' && call[1] === 'session=a')).toEqual(expect.arrayContaining([['/api/shared', 'session=a', 'one'], ['/api/shared', 'session=a', 'two']]));
    expect(calls.filter((call) => Array.isArray(call) && call[0] === '/api/shared' && call[1] === 'session=a')).toHaveLength(2);
    expect(calls.filter((call) => Array.isArray(call) && call[0] === '/api/shared' && call[1] === 'session=b')).toHaveLength(2);
    expect(calls.filter((call) => Array.isArray(call) && call[0] === '/api/hot' && call[1] === 'session=a')).toHaveLength(2);
    expect(calls).not.toContainEqual(['/api/hot', 'session=b', 'two']);
  } finally { await worker.dispose(); }
});
