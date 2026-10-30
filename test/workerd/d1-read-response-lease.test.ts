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
