import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { resolve } from 'node:path';

const source = `
import { createD1CacheRuntime, d1PrismaCacheExtension } from './env';
import { cacheD1Read } from './read';
import { createDurableObjectStore } from '../cloudflare/store';
export { CacheCoordinator } from '../cloudflare/coordinator';
const profile = { envPrefix:'TEST', bindingNames:['DB'], bindingPrefixes:[], coordinatorNamePrefix:'test:', coordinatorClass:'CacheCoordinator', readModels:['Meta'], unfencedWriteTables:[] };
const extraModels = Array.from({ length:800 }, (_, index) => 'GeneratedModel' + String(index).padStart(4, '0'));
const config = { cacheVersion:'large-test', configFormat:2, hasDecimalFields:false, modelNames:['Meta', ...extraModels], cacheableByModel:{ Meta:true, ...Object.fromEntries(extraModels.map((model) => [model, false])) }, primaryKeyFieldsByModel:{ Meta:['id'], ...Object.fromEntries(extraModels.map((model) => [model, ['id']])) }, primaryKeyNameByModel:{}, relationGraph:Object.fromEntries(extraModels.map((model) => [model, []])) };
if (new TextEncoder().encode(JSON.stringify(config)).byteLength <= 32768) throw Error('fixture is not large');
export default { async fetch(request, env) {
  const store = createDurableObjectStore(env.COORDINATOR, { name:'test:db' });
  let reads = 0;
  const tracked = { ...store, read: async (input) => { reads++; return store.read(input); } };
  const db = createD1CacheRuntime(env.DB, { store:tracked, databaseId:'db', generation:'1', coordinatorName:'test:db', regionalIdentity:env.COORDINATOR.idFromName('test:db').toString(), profile });
  const url = new URL(request.url);
  const ttl = url.searchParams.has('strict') ? 0 : 5000;
  if (url.searchParams.has('prisma')) {
    let queries = 0;
    const extension = d1PrismaCacheExtension(db, config, { scope:'actor', regionalTtlMs:ttl, regionalModels:['Meta'] });
    if (!extension) throw Error('extension missing');
    const value = await extension.query.$allModels.$allOperations({ model:'Meta', operation:'findMany', args:{ where:{ id:1 } }, query:async () => { queries++; return [{ id:1 }]; } });
    return Response.json({ value, reads, queries });
  }
  const value = await cacheD1Read(db, { key:'regional-test', scope:'actor', regionalTtlMs:ttl }, async () => 42);
  return Response.json({ value, reads });
} };`;

it('reuses regional values across HTTP invocations and strict reads reach the coordinator', async () => {
  const bundle = await build({ stdin:{ contents:source, resolveDir:resolve(__dirname, '../../src/d1'), loader:'ts' }, bundle:true, format:'esm', platform:'neutral', target:'es2022', external:['cloudflare:workers'], write:false });
  const output = bundle.outputFiles[0];
  if (!output) throw new Error('bundle missing');
  const worker = new Miniflare({ modules:true, script:output.text, compatibilityDate:'2026-01-01', d1Databases:['DB'], durableObjects:{ COORDINATOR:{ className:'CacheCoordinator', useSQLite:true } } });
  try {
    expect(await (await worker.dispatchFetch('http://cache.test/')).json()).toEqual({ value:42, reads:1 });
    expect(await (await worker.dispatchFetch('http://cache.test/')).json()).toEqual({ value:42, reads:0 });
    expect(await (await worker.dispatchFetch('http://cache.test/?strict')).json()).toEqual({ value:42, reads:1 });
    expect(await (await worker.dispatchFetch('http://cache.test/?prisma')).json()).toEqual({ value:[{ id:1 }], reads:1, queries:1 });
    expect(await (await worker.dispatchFetch('http://cache.test/?prisma')).json()).toEqual({ value:[{ id:1 }], reads:0, queries:0 });
    expect(await (await worker.dispatchFetch('http://cache.test/?prisma&strict')).json()).toEqual({ value:[{ id:1 }], reads:1, queries:0 });
  } finally { await worker.dispose(); }
});
