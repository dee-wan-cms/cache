import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { resolve } from 'node:path';

const source = `
import { createD1CacheRuntime } from './env';
import { wrapD1ReadResponseLease, limitD1ReadLeaseUntil } from './read-response-lease';
const profile = { envPrefix:'TEST', bindingNames:['DB'], bindingPrefixes:[], coordinatorNamePrefix:'test:', coordinatorClass:'CacheCoordinator', readModels:[], unfencedWriteTables:[], readResponseLease:{ databaseBinding:'DB', deploymentEnv:'RELEASE', paths:['/metadata', '/items/*'], credentialHeaders:['cookie'], varyHeaders:['origin', 'x-site-id'], freshnessCookie:'fresh' } };
const store = { read:async () => { throw Error('unexpected'); }, write:async () => { throw Error('unexpected'); }, release:async () => {}, beginWrite:async () => {}, endWrite:async () => {}, invalidate:async () => {} };
let calls = 0;
const handler = wrapD1ReadResponseLease(async (request) => { limitD1ReadLeaseUntil(Date.now() + 10000); return Response.json({ calls:++calls, control:request.headers.get('cache-control') }, { headers:{ 'cache-control':'private, no-store', vary:'Origin' } }); }, profile);
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
    expect(await warm.json()).toEqual({ calls:1, control:'no-cache' });
    expect(warm.headers.get('cache-control')).toBe('private, no-store');
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
  const origin = await makeBundle(originSource);
  const gateway = await makeBundle(gatewaySource);
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
