import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { resolve } from 'node:path';

const source = `
import { createD1CacheRuntime } from './env';
import { wrapD1ReadResponseLease, limitD1ReadLeaseUntil } from './read-response-lease';
const profile = { envPrefix:'TEST', bindingNames:['DB'], bindingPrefixes:[], coordinatorNamePrefix:'test:', coordinatorClass:'CacheCoordinator', readModels:[], unfencedWriteTables:[], readResponseLease:{ databaseBinding:'DB', deploymentEnv:'RELEASE', paths:['/metadata', '/items/*'], credentialHeaders:['cookie'], varyHeaders:['origin', 'x-site-id'], freshnessCookie:'fresh', ignoreRequestCacheControl:true } };
const store = { read:async () => { throw Error('unexpected'); }, write:async () => { throw Error('unexpected'); }, release:async () => {}, beginWrite:async () => {}, endWrite:async () => {}, invalidate:async () => {} };
let calls = 0;
const handler = wrapD1ReadResponseLease(async (request) => { limitD1ReadLeaseUntil(Date.now() + 10000); return Response.json({ calls:++calls, control:request.headers.get('cache-control') }, { headers:{ 'cache-control':'private, no-store', vary:'Origin', etag:'"native,tag"', 'last-modified':'Wed, 21 Oct 2015 07:28:00 GMT' } }); }, profile);
export default { async fetch(request, env, context) { const DB = createD1CacheRuntime(env.DB, { store, databaseId:'db', generation:'1', coordinatorName:'db', regionalIdentity:'coordinator', profile }); return handler(request, { DB, RELEASE:'release-1', TEST_READ_ACCESS_SECONDS:'5' }, context); } };`;

it('reuses an authenticated response across requests and refreshes after a write marker', async () => {
  const bundle = await build({ stdin:{ contents:source, resolveDir:resolve(__dirname, '../../src/d1'), loader:'ts' }, bundle:true, format:'esm', platform:'neutral', target:'es2022', external:['cloudflare:workers', 'node:async_hooks'], write:false });
  const output = bundle.outputFiles[0];
  if (!output) throw Error('bundle missing');
  const worker = new Miniflare({ modules:true, script:output.text, compatibilityDate:'2026-01-01', compatibilityFlags:['nodejs_compat'], d1Databases:['DB'] });
  try {
    const headers = { cookie:'session=a', origin:'https://site.example' };
    expect(await (await worker.dispatchFetch('https://cache.test/metadata', { headers })).json()).toEqual({ calls:1, control:'no-cache' });
    const warm = await worker.dispatchFetch('https://cache.test/metadata', { headers });
    expect(warm.bodyUsed).toBe(false);
    expect(await warm.json()).toEqual({ calls:1, control:'no-cache' });
    expect(warm.headers.get('cache-control')).toBe('private, no-store');
    expect(warm.headers.has('x-dee-wan-lease-meta')).toBe(false);
    const conditional = await worker.dispatchFetch('https://cache.test/metadata', { headers:{ ...headers, 'if-none-match':'W/"native,tag"' } });
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe('');
    expect(conditional.headers.get('etag')).toBe('"native,tag"');
    expect(conditional.headers.get('cache-control')).toBe('private, no-store');
    expect(conditional.headers.has('content-length')).toBe(false);
    expect(await (await worker.dispatchFetch('https://cache.test/metadata', { headers:{ ...headers, 'if-none-match':'"other"' } })).json()).toHaveProperty('calls', 1);
    expect(await (await worker.dispatchFetch('https://cache.test/metadata', { headers:{ ...headers, cookie:'session=b' } })).json()).toEqual({ calls:2, control:'no-cache' });
    const write = await worker.dispatchFetch('https://cache.test/metadata', { method:'POST', headers });
    expect(write.headers.get('set-cookie')).toContain('fresh=1');
    expect(await (await worker.dispatchFetch('https://cache.test/metadata', { headers:{ ...headers, cookie:'session=a; fresh=1' } })).json()).toEqual({ calls:4, control:'no-cache' });
  } finally { await worker.dispose(); }
});

const originSource = `
import { wrapD1ReadLeaseOrigin, limitD1ReadLeaseUntil } from './read-response-lease';
let calls = 0;
const handler = wrapD1ReadLeaseOrigin(async (request) => {
  const url = new URL(request.url);
  if (url.pathname === '/events') return new Response('data: hello\\n\\n', { headers:{ 'content-type':'text/event-stream' } });
  if (url.pathname === '/socket') { const pair = new WebSocketPair(); pair[1].accept(); return new Response(null, { status:101, webSocket:pair[0] }); }
  const forged = request.headers.has('x-dee-wan-read-lease-deadline');
  if (request.headers.get('cookie') !== 'session=invalid') limitD1ReadLeaseUntil(Date.now() + 10000);
  return Response.json({ calls:++calls, forged, control:request.headers.get('cache-control') }, { headers:{ 'cache-control':'private, no-store', 'x-dee-wan-read-lease-deadline':'9999999999999' } });
});
export default { fetch:handler };`;
const gatewaySource = `
import { createD1CacheRuntime } from './env';
import { wrapD1ReadResponseLease, forwardD1ReadLease } from './read-response-lease';
const profile = { envPrefix:'TEST', bindingNames:['DB'], bindingPrefixes:[], coordinatorNamePrefix:'test:', coordinatorClass:'CacheCoordinator', readModels:[], unfencedWriteTables:[], readResponseLease:{ databaseBinding:'DB', deploymentEnv:'RELEASE', paths:['/metadata'], credentialHeaders:['cookie'], varyHeaders:['origin', 'x-site-id'], freshnessCookie:'fresh' } };
const store = { read:async () => { throw Error('unexpected'); }, write:async () => { throw Error('unexpected'); }, release:async () => {}, beginWrite:async () => {}, endWrite:async () => {}, invalidate:async () => {} };
const handler = wrapD1ReadResponseLease((request, env) => forwardD1ReadLease(request, env.ORIGIN), profile);
export default { async fetch(request, env, context) { const DB = createD1CacheRuntime(env.DB, { store, databaseId:'db', generation:'1', coordinatorName:'db', regionalIdentity:'coordinator', profile }); return handler(request, { DB, ORIGIN:env.ORIGIN, RELEASE:'release-1', TEST_READ_ACCESS_SECONDS:'5' }, context); } };`;

it('transports verified leases across a trusted service binding without exposing proof', async () => {
  const makeBundle = async (contents: string) => {
    const bundle = await build({ stdin:{ contents, resolveDir:resolve(__dirname, '../../src/d1'), loader:'ts' }, bundle:true, format:'esm', platform:'neutral', target:'es2022', external:['cloudflare:workers', 'node:async_hooks'], write:false });
    const output = bundle.outputFiles[0];
    if (!output) throw Error('bundle missing');
    return output.text;
  };
  const origin = await makeBundle(originSource.replace("  const forged = request.headers.has('x-dee-wan-read-lease-deadline');", "  if (request.method === 'GET' && url.pathname === '/metadata' && !request.headers.get('cookie')?.includes('fresh=1') && request.headers.get('x-read-fresh') !== '1') throw Error('missing internal freshness header');\n  const forged = request.headers.has('x-dee-wan-read-lease-deadline');"));
  const gateway = await makeBundle(gatewaySource.replace("freshnessCookie:'fresh'", "freshnessCookie:'fresh', freshnessHeader:'x-read-fresh'"));
  const worker = new Miniflare({ workers:[
    { name:'gateway', modules:true, script:gateway, compatibilityDate:'2026-01-01', compatibilityFlags:['nodejs_compat'], d1Databases:['DB'], serviceBindings:{ ORIGIN:'origin' } },
    { name:'origin', modules:true, script:origin, compatibilityDate:'2026-01-01', compatibilityFlags:['nodejs_compat'] },
  ] });
  try {
    const headers = { cookie:'session=a', origin:'https://site.example', 'x-site-id':'site-a', 'x-dee-wan-read-lease-deadline':'9999999999999' };
    const first = await worker.dispatchFetch('https://cache.test/metadata', { headers });
    expect(first.headers.has('x-dee-wan-read-lease-deadline')).toBe(false);
    expect(await first.json()).toEqual({ calls:1, forged:false, control:'no-cache' });
    expect(await (await worker.dispatchFetch('https://cache.test/metadata', { headers })).json()).toEqual({ calls:1, forged:false, control:'no-cache' });
    expect(await (await worker.dispatchFetch('https://cache.test/metadata', { headers:{ ...headers, cookie:'session=b' } })).json()).toHaveProperty('calls', 2);
    expect(await (await worker.dispatchFetch('https://cache.test/metadata', { headers:{ ...headers, 'x-site-id':'site-b' } })).json()).toHaveProperty('calls', 3);
    const write = await worker.dispatchFetch('https://cache.test/metadata', { method:'POST', headers });
    expect(write.headers.get('set-cookie')).toContain('fresh=1');
    expect(await (await worker.dispatchFetch('https://cache.test/metadata', { headers:{ ...headers, cookie:'session=a; fresh=1' } })).json()).toHaveProperty('calls', 5);
    const invalid = { ...headers, cookie:'session=invalid' };
    expect(await (await worker.dispatchFetch('https://cache.test/metadata', { headers:invalid })).json()).toHaveProperty('calls', 6);
    expect(await (await worker.dispatchFetch('https://cache.test/metadata', { headers:invalid })).json()).toHaveProperty('calls', 7);
    const events = await worker.dispatchFetch('https://cache.test/events', { headers });
    expect(events.headers.has('x-dee-wan-read-lease-deadline')).toBe(false);
    expect(await events.text()).toBe('data: hello\n\n');
    const socket = await worker.dispatchFetch('https://cache.test/socket', { headers:{ ...headers, Upgrade:'websocket' } });
    expect(socket.status).toBe(101);
    expect(socket.headers.has('x-dee-wan-read-lease-deadline')).toBe(false);
  } finally { await worker.dispose(); }
});

const deadlineOriginSource = `
import { createD1CacheRuntime } from './env';
import { cacheD1Read } from './read';
import { wrapD1ReadLeaseOrigin, limitD1ReadLeaseUntil } from './read-response-lease';
let now = 100000;
Date.now = () => now;
let loads = 0, calls = 0;
const profile = { envPrefix:'TEST', bindingNames:['DB'], bindingPrefixes:[], coordinatorNamePrefix:'test:', coordinatorClass:'CacheCoordinator', readModels:[], unfencedWriteTables:[] };
const store = { read:async () => ({ kind:'miss', epochs:{ g:0 }, lockHeldForMs:null, lockToken:'lock', pending:false }), write:async () => ({ ok:true }), release:async () => {}, beginWrite:async () => {}, endWrite:async () => {}, invalidate:async () => {} };
const handler = wrapD1ReadLeaseOrigin(async (request, env) => {
  if (new URL(request.url).pathname !== '/seed') { calls++; limitD1ReadLeaseUntil(120000); }
  const db = createD1CacheRuntime(env.DB, { store, databaseId:'data', generation:'1', coordinatorName:'data', regionalIdentity:'data-coord', profile });
  const value = await cacheD1Read(db, { key:'metadata', scope:'actor', regionalTtlMs:5000 }, async () => ++loads);
  return Response.json({ value, calls });
});
export default { fetch(request, env, context) { now = Number(request.headers.get('x-test-now')); return handler(request, env, context); } };`;
const deadlineGatewaySource = `
import { createD1CacheRuntime } from './env';
import { wrapD1ReadResponseLease, forwardD1ReadLease } from './read-response-lease';
let now = 100000;
Date.now = () => now;
const profile = { envPrefix:'TEST', bindingNames:['DB'], bindingPrefixes:[], coordinatorNamePrefix:'test:', coordinatorClass:'CacheCoordinator', readModels:[], unfencedWriteTables:[], readResponseLease:{ databaseBinding:'DB', deploymentEnv:'RELEASE', paths:['/metadata'], credentialHeaders:['cookie'], varyHeaders:[], freshnessCookie:'fresh' } };
const store = { read:async () => { throw Error('unexpected'); }, write:async () => { throw Error('unexpected'); }, release:async () => {}, beginWrite:async () => {}, endWrite:async () => {}, invalidate:async () => {} };
const handler = wrapD1ReadResponseLease((request, env) => forwardD1ReadLease(request, env.ORIGIN), profile);
export default { fetch(request, env, context) { now = Number(request.headers.get('x-test-now')); const DB = createD1CacheRuntime(env.DB, { store, databaseId:'db', generation:'1', coordinatorName:'db', regionalIdentity:'coord', profile }); return handler(request, { DB, ORIGIN:env.ORIGIN, RELEASE:'release', TEST_READ_ACCESS_SECONDS:'5' }, context); } };`;

it('carries the inner data deadline through a native service binding without extending its age', async () => {
  const makeBundle = async (contents: string) => {
    const bundle = await build({ stdin:{ contents, resolveDir:resolve(__dirname, '../../src/d1'), loader:'ts' }, bundle:true, format:'esm', platform:'neutral', target:'es2022', external:['cloudflare:workers', 'node:async_hooks'], write:false });
    const output = bundle.outputFiles[0];
    if (!output) throw Error('bundle missing');
    return output.text;
  };
  const origin = await makeBundle(deadlineOriginSource);
  const gateway = await makeBundle(deadlineGatewaySource);
  const worker = new Miniflare({ workers:[
    { name:'gateway', modules:true, script:gateway, compatibilityDate:'2026-01-01', compatibilityFlags:['nodejs_compat'], d1Databases:['DB'], serviceBindings:{ ORIGIN:'origin' } },
    { name:'origin', modules:true, script:origin, compatibilityDate:'2026-01-01', compatibilityFlags:['nodejs_compat'], d1Databases:['DB'] },
  ] });
  try {
    const fetch = (path: string, now: number) => worker.dispatchFetch(`https://cache.test${path}`, { headers:{ cookie:'session=a', 'x-test-now':String(now) } });
    expect(await (await fetch('/seed', 100000)).json()).toEqual({ value:1, calls:0 });
    const first = await fetch('/metadata', 104000);
    expect(first.headers.has('x-dee-wan-read-lease-deadline')).toBe(false);
    expect(await first.json()).toEqual({ value:1, calls:1 });
    expect(await (await fetch('/metadata', 104999)).json()).toEqual({ value:1, calls:1 });
    expect(await (await fetch('/metadata', 105000)).json()).toEqual({ value:2, calls:2 });
    expect(await (await fetch('/metadata', 105001)).json()).toEqual({ value:2, calls:2 });
  } finally { await worker.dispose(); }
});

const longLeaseSource = `
import { createD1CacheRuntime } from './env';
import { wrapD1ReadResponseLease, limitD1ReadLeaseUntil } from './read-response-lease';
let now = 100000, calls = 0;
Date.now = () => now;
const profile = { envPrefix:'TEST', bindingNames:['DB'], bindingPrefixes:[], coordinatorNamePrefix:'test:', coordinatorClass:'CacheCoordinator', readModels:[], unfencedWriteTables:[], readResponseLease:{ databaseBinding:'DB', deploymentEnv:'RELEASE', paths:['/metadata'], credentialHeaders:['cookie'], varyHeaders:[], freshnessCookie:'fresh', freshnessHeader:'x-read-fresh', maxSeconds:30 } };
const store = { read:async () => { throw Error('unexpected'); }, write:async () => { throw Error('unexpected'); }, release:async () => {}, beginWrite:async () => {}, endWrite:async () => {}, invalidate:async () => {} };
const handler = wrapD1ReadResponseLease(async () => { limitD1ReadLeaseUntil(200000); return Response.json({ calls:++calls }); }, profile);
export default { fetch(request, env, context) { now = Number(request.headers.get('x-test-now')); const DB = createD1CacheRuntime(env.DB, { store, databaseId:'db', generation:'1', coordinatorName:'db', regionalIdentity:'coordinator', profile }); return handler(request, { DB, RELEASE:'release-1', TEST_READ_ACCESS_SECONDS:'30' }, context); } };`;

it('enforces a thirty-second response lease and writer freshness in native Cache API', async () => {
  const bundle = await build({ stdin:{ contents:longLeaseSource, resolveDir:resolve(__dirname, '../../src/d1'), loader:'ts' }, bundle:true, format:'esm', platform:'neutral', target:'es2022', external:['cloudflare:workers', 'node:async_hooks'], write:false });
  const output = bundle.outputFiles[0];
  if (!output) throw Error('bundle missing');
  const worker = new Miniflare({ modules:true, script:output.text, compatibilityDate:'2026-01-01', compatibilityFlags:['nodejs_compat'], d1Databases:['DB'] });
  try {
    const fetch = (now: number, method = 'GET', cookie = 'session=a') => worker.dispatchFetch('https://cache.test/metadata', { method, headers:{ cookie, 'x-test-now':String(now) } });
    expect(await (await fetch(100000)).json()).toHaveProperty('calls', 1);
    expect(await (await fetch(129999)).json()).toHaveProperty('calls', 1);
    const write = await fetch(129999, 'POST');
    expect(write.headers.get('set-cookie')).toContain('fresh=1; Max-Age=30;');
    expect(await (await fetch(129999, 'GET', 'session=a; fresh=1')).json()).toHaveProperty('calls', 3);
    expect(await (await fetch(130000)).json()).toHaveProperty('calls', 4);
    const forced = await worker.dispatchFetch('https://cache.test/metadata', { headers:{ cookie:'session=a', 'x-test-now':'130001', 'x-read-fresh':'1' } });
    expect(await forced.json()).toHaveProperty('calls', 5);
    expect(await (await fetch(130002)).json()).toHaveProperty('calls', 5);
    expect(await (await fetch(160001)).json()).toHaveProperty('calls', 6);
  } finally { await worker.dispose(); }
});

it('reuses each writer generation and isolates the next in native Cache API', async () => {
  const source = longLeaseSource.replace('maxSeconds:30 }', "maxSeconds:30, freshnessCookieMode:'generation', cookieNames:['session', 'secure-session', 'access', 'fresh'] }");
  const bundle = await build({ stdin:{ contents:source, resolveDir:resolve(__dirname, '../../src/d1'), loader:'ts' }, bundle:true, format:'esm', platform:'neutral', target:'es2022', external:['cloudflare:workers', 'node:async_hooks'], write:false });
  const output = bundle.outputFiles[0];
  if (!output) throw Error('bundle missing');
  const worker = new Miniflare({ modules:true, script:output.text, compatibilityDate:'2026-01-01', compatibilityFlags:['nodejs_compat'], d1Databases:['DB'] });
  try {
    const fetch = (method = 'GET', cookie = 'session=a') => worker.dispatchFetch('https://cache.test/metadata', { method, headers:{ cookie, 'x-test-now':'100000' } });
    expect(await (await fetch()).json()).toHaveProperty('calls', 1);
    expect(await (await fetch('GET', 'session=a; nuisance=one')).json()).toHaveProperty('calls', 1);
    const first = (await fetch('POST')).headers.get('set-cookie')?.match(/fresh=([^;]+)/)?.[1];
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(await (await fetch('GET', `session=a; fresh=${first}`)).json()).toHaveProperty('calls', 3);
    expect(await (await fetch('GET', `session=a; nuisance=two; fresh=${first}`)).json()).toHaveProperty('calls', 3);
    const second = (await fetch('POST')).headers.get('set-cookie')?.match(/fresh=([^;]+)/)?.[1];
    expect(second).not.toBe(first);
    expect(await (await fetch('GET', `session=a; fresh=${second}`)).json()).toHaveProperty('calls', 5);
    expect(await (await fetch('GET', `session=a; fresh=${second}`)).json()).toHaveProperty('calls', 5);
    expect(await (await fetch('GET', 'secure-session=a')).json()).toHaveProperty('calls', 6);
    expect(await (await fetch('GET', 'access=a')).json()).toHaveProperty('calls', 7);
    expect(await (await fetch('GET', 'session=a; session=b')).json()).toHaveProperty('calls', 8);
    expect(await (await fetch('GET', 'session=b; session=a')).json()).toHaveProperty('calls', 9);
    expect(await (await fetch('GET', 'nuisance=one')).json()).toHaveProperty('calls', 10);
    expect(await (await fetch('GET', 'nuisance=two')).json()).toHaveProperty('calls', 11);
  } finally { await worker.dispose(); }
});

it('enforces a 300-second lease in native Cache API without extending it on hits', async () => {
  const source = longLeaseSource.replace('maxSeconds:30 }', 'maxSeconds:300 }').replace("TEST_READ_ACCESS_SECONDS:'30'", "TEST_READ_ACCESS_SECONDS:'300'").replace('limitD1ReadLeaseUntil(200000)', 'limitD1ReadLeaseUntil(500000)');
  const bundle = await build({ stdin:{ contents:source, resolveDir:resolve(__dirname, '../../src/d1'), loader:'ts' }, bundle:true, format:'esm', platform:'neutral', target:'es2022', external:['cloudflare:workers', 'node:async_hooks'], write:false });
  const output = bundle.outputFiles[0];
  if (!output) throw Error('bundle missing');
  const worker = new Miniflare({ modules:true, script:output.text, compatibilityDate:'2026-01-01', compatibilityFlags:['nodejs_compat'], d1Databases:['DB'] });
  try {
    const fetch = (now: number, method = 'GET') => worker.dispatchFetch('https://cache.test/metadata', { method, headers:{ cookie:'session=a', 'x-test-now':String(now) } });
    expect(await (await fetch(100000)).json()).toHaveProperty('calls', 1);
    expect(await (await fetch(399999)).json()).toHaveProperty('calls', 1);
    expect((await fetch(399999, 'POST')).headers.get('set-cookie')).toContain('fresh=1; Max-Age=300;');
    expect(await (await fetch(400000)).json()).toHaveProperty('calls', 3);
  } finally { await worker.dispose(); }
});

it('reuses a multi-megabyte response across native Cache API requests', async () => {
  const source = longLeaseSource.replace('return Response.json({ calls:++calls });', "return Response.json({ calls:++calls, items:Array.from({ length:3000 }, (_, id) => ({ id, value:'x'.repeat(1000) })) });");
  const bundle = await build({ stdin:{ contents:source, resolveDir:resolve(__dirname, '../../src/d1'), loader:'ts' }, bundle:true, format:'esm', platform:'neutral', target:'es2022', external:['cloudflare:workers', 'node:async_hooks'], write:false });
  const output = bundle.outputFiles[0];
  if (!output) throw Error('bundle missing');
  const worker = new Miniflare({ modules:true, script:output.text, compatibilityDate:'2026-01-01', compatibilityFlags:['nodejs_compat'], d1Databases:['DB'] });
  try {
    const fetch = () => worker.dispatchFetch('https://cache.test/metadata', { headers:{ cookie:'session=a', 'x-test-now':'100000' } });
    const first = await (await fetch()).text();
    expect(new TextEncoder().encode(first).byteLength).toBeGreaterThan(3_000_000);
    expect(JSON.parse(first)).toHaveProperty('calls', 1);
    const warm = await (await fetch()).text();
    expect(warm).toBe(first);
  } finally { await worker.dispose(); }
});

it('negotiates identity encoding and reuses a large origin response across the service binding', async () => {
  const source = originSource.replace("{ calls:++calls, forged, control:request.headers.get('cache-control') }", "{ calls:++calls, forged, encoding:request.headers.get('accept-encoding'), authorization:request.headers.get('authorization'), site:request.headers.get('x-site-id'), items:Array.from({ length:3000 }, (_, id) => ({ id, value:'x'.repeat(1000) })) }");
  const makeBundle = async (contents: string) => {
    const bundle = await build({ stdin:{ contents, resolveDir:resolve(__dirname, '../../src/d1'), loader:'ts' }, bundle:true, format:'esm', platform:'neutral', target:'es2022', external:['cloudflare:workers', 'node:async_hooks'], write:false });
    const output = bundle.outputFiles[0];
    if (!output) throw Error('bundle missing');
    return output.text;
  };
  const origin = await makeBundle(source);
  const gateway = await makeBundle(gatewaySource);
  const worker = new Miniflare({ workers:[
    { name:'gateway', modules:true, script:gateway, compatibilityDate:'2026-01-01', compatibilityFlags:['nodejs_compat'], d1Databases:['DB'], serviceBindings:{ ORIGIN:'origin' } },
    { name:'origin', modules:true, script:origin, compatibilityDate:'2026-01-01', compatibilityFlags:['nodejs_compat'] },
  ] });
  try {
    const headers = { cookie:'session=a', authorization:'Bearer token', origin:'https://site.example', 'x-site-id':'site-a', 'accept-encoding':'br, gzip', 'x-dee-wan-read-lease-deadline':'forged' };
    const firstResponse = await worker.dispatchFetch('https://cache.test/metadata', { headers });
    expect(firstResponse.headers.has('x-dee-wan-read-lease-deadline')).toBe(false);
    const first = await firstResponse.text();
    expect(new TextEncoder().encode(first).byteLength).toBeGreaterThan(3_000_000);
    expect(JSON.parse(first)).toMatchObject({ calls:1, forged:false, encoding:'identity', authorization:'Bearer token', site:'site-a' });
    const warm = await worker.dispatchFetch('https://cache.test/metadata', { headers });
    expect(warm.headers.has('x-dee-wan-read-lease-deadline')).toBe(false);
    expect(await warm.text()).toBe(first);
  } finally { await worker.dispose(); }
});

const streamingOriginSource = `
import { wrapD1ReadLeaseOrigin, limitD1ReadLeaseUntil } from './read-response-lease';
let calls = 0;
const handler = wrapD1ReadLeaseOrigin(async () => {
  calls++;
  limitD1ReadLeaseUntil(Date.now() + 30000);
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"calls":' + calls)); setTimeout(() => { controller.enqueue(new TextEncoder().encode('}')); controller.close(); }, 1200); } });
  return new Response(stream, { headers:{ 'content-type':'application/json', 'cache-control':'private, no-store' } });
});
export default { fetch:handler };`;
const streamingGatewaySource = `
import { createD1CacheRuntime } from './env';
import { wrapD1ReadResponseLease, forwardD1ReadLease } from './read-response-lease';
const profile = { envPrefix:'TEST', bindingNames:['DB'], bindingPrefixes:[], coordinatorNamePrefix:'test:', coordinatorClass:'CacheCoordinator', readModels:[], unfencedWriteTables:[], readResponseLease:{ databaseBinding:'DB', deploymentEnv:'RELEASE', paths:['/metadata'], credentialHeaders:['cookie'], varyHeaders:[], freshnessCookie:'fresh' } };
const store = { read:async () => { throw Error('unexpected'); }, write:async () => { throw Error('unexpected'); }, release:async () => {}, beginWrite:async () => {}, endWrite:async () => {}, invalidate:async () => {} };
const handler = wrapD1ReadResponseLease((request, env) => forwardD1ReadLease(request, env.ORIGIN), profile);
let completed = 0;
export default { async fetch(request, env, context) {
  const path = new URL(request.url).pathname;
  if (path === '/fill-state') return Response.json({ completed });
  const DB = createD1CacheRuntime(env.DB, { store, databaseId:'db', generation:'1', coordinatorName:'db', regionalIdentity:'coordinator', profile });
  return handler(request, { DB, ORIGIN:env.ORIGIN, RELEASE:'release-1', TEST_READ_ACCESS_SECONDS:'5' }, { waitUntil(task) { context.waitUntil(task.then(() => { completed++; })); } });
} };`;

it('streams a service-binding response before its background Cache API fill completes', async () => {
  const makeBundle = async (contents: string) => {
    const bundle = await build({ stdin:{ contents, resolveDir:resolve(__dirname, '../../src/d1'), loader:'ts' }, bundle:true, format:'esm', platform:'neutral', target:'es2022', external:['cloudflare:workers', 'node:async_hooks'], write:false });
    const output = bundle.outputFiles[0];
    if (!output) throw Error('bundle missing');
    return output.text;
  };
  const gateway = await makeBundle(streamingGatewaySource);
  const origin = await makeBundle(streamingOriginSource);
  const worker = new Miniflare({ workers:[
    { name:'gateway', modules:true, script:gateway, compatibilityDate:'2026-01-01', compatibilityFlags:['nodejs_compat'], d1Databases:['DB'], serviceBindings:{ ORIGIN:'origin' } },
    { name:'origin', modules:true, script:origin, compatibilityDate:'2026-01-01', compatibilityFlags:['nodejs_compat'] },
  ] });
  try {
    const headers = { cookie:'session=a' };
    const first = await worker.dispatchFetch('https://cache.test/metadata', { headers });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ calls:1 });
    let filled = false;
    for (let attempt = 0; attempt < 50 && !filled; attempt++) {
      const state: unknown = await (await worker.dispatchFetch('https://cache.test/fill-state')).json();
      filled = !!state && typeof state === 'object' && Reflect.get(state, 'completed') === 1;
    }
    expect(filled).toBe(true);
    expect(await (await worker.dispatchFetch('https://cache.test/metadata', { headers })).json()).toEqual({ calls:1 });
  } finally { await worker.dispose(); }
});
