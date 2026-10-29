import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { resolve } from 'node:path';

const source = `
import { cacheD1Env, createD1CacheRuntime } from './env';
import { cacheD1Read } from './read';
import { cacheD1JsonRead } from './json-read';
import { createDurableObjectStore } from '../cloudflare/store';
export { CacheCoordinator } from '../cloudflare/coordinator';
const profile = { envPrefix:'TEST_CACHE', bindingNames:['DB','OTHER'], bindingPrefixes:['ALIAS_'], coordinatorNamePrefix:'test:', coordinatorClass:'CacheCoordinator', readModels:[], unfencedWriteTables:[] };
const ids = { DB:'00000000-0000-0000-0000-000000000001', OTHER:'00000000-0000-0000-0000-000000000002', ALIAS_same:'00000000-0000-0000-0000-000000000001' };
export default { async fetch(request, env) {
  const base = { ...env, ALIAS_same:env.DB, TEST_CACHE_ENABLED:'true', TEST_CACHE_GENERATION:'1', TEST_CACHE_DATABASE_IDS:JSON.stringify(ids) };
  const e = cacheD1Env(base, profile);
  const disabled = cacheD1Env({ ...base, TEST_CACHE_READS_ENABLED:'false' }, profile);
  let loads = 0;
  const options = { key:{ route:'catalogue' }, scope:{ site:'site-a', actor:'actor-a', permissions:['read'] }, dependencies:[e.OTHER,e.ALIAS_same] };
  const load = async () => { loads++; const a = await env.DB.prepare('SELECT value FROM item WHERE id=1').first(); const b = await env.OTHER.prepare('SELECT value FROM item WHERE id=1').first(); return { a:a.value,b:b.value }; };
  const first = await cacheD1Read(e.DB, options, load);
  const warm = await cacheD1Read(e.DB, options, load);
  const warmLoads = loads;
  await cacheD1Read(e.DB, { ...options, scope:{ site:'site-a',actor:'actor-b',permissions:['read'] } }, load);
  await cacheD1Read(e.DB, { ...options, scope:{ site:'site-b',actor:'actor-a',permissions:['read'] } }, load);
  await cacheD1Read(e.DB, { ...options, scope:{ site:'site-a',actor:'actor-a',permissions:['read','write'] } }, load);
  await cacheD1Read(e.DB, { ...options, key:{ route:'other' } }, load);
  const separated = loads;
  await e.OTHER.prepare("UPDATE item SET value='b2' WHERE id=1").run();
  const afterOther = await cacheD1Read(e.DB, options, load);
  await e.DB.prepare("UPDATE item SET value='a2' WHERE id=1").run();
  const afterPrimary = await cacheD1Read(e.DB, options, load);
  const otherStore = createDurableObjectStore(env.TEST_CACHE_COORDINATOR, { name:'test:'+ids.OTHER });
  await otherStore.beginWrite({ fences:['g'], generation:'1', leaseMs:60000, token:'lease' });
  const beforePending = loads;
  await cacheD1Read(e.DB, options, load);
  const pendingBypass = loads - beforePending;
  await otherStore.endWrite({ fences:['g'], token:'lease' });
  const primaryStore = createDurableObjectStore(env.TEST_CACHE_COORDINATOR, { name:'test:'+ids.DB });
  await primaryStore.beginWrite({ fences:['g'], generation:'1', leaseMs:60000, token:'primary-lease' });
  const beforePrimaryPending = loads;
  await cacheD1Read(e.DB, options, load);
  const primaryPendingBypass = loads - beforePrimaryPending;
  await primaryStore.endWrite({ fences:['g'], token:'primary-lease' });
  let release, reached;
  const paused = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { reached = resolve; });
  const raceLoad = async () => { const value = await load(); reached(); await paused; return value; };
  const racing = cacheD1Read(e.DB, { ...options, key:'race' }, raceLoad);
  await started;
  await e.OTHER.prepare("UPDATE item SET value='b3' WHERE id=1").run();
  release();
  await racing;
  const afterRace = await cacheD1Read(e.DB, { ...options, key:'race' }, load);
  const current = await cacheD1Read(e.DB, { ...options, key:'race' }, load);
  const store = createDurableObjectStore(env.TEST_CACHE_COORDINATOR, { name:'test:'+ids.DB });
  const withoutInspect = { ...otherStore, inspectFences:undefined };
  const noInspection = createD1CacheRuntime(env.OTHER, { store:withoutInspect, databaseId:ids.OTHER, generation:'1', profile });
  let noInspectLoads = 0;
  await cacheD1Read(e.DB, { key:'noinspect', scope:'a', dependencies:[noInspection] }, async () => ++noInspectLoads);
  await cacheD1Read(e.DB, { key:'noinspect', scope:'a', dependencies:[noInspection] }, async () => ++noInspectLoads);
  const primaryWithoutInspection = createD1CacheRuntime(env.DB, { store:{ ...store, inspectFences:undefined }, databaseId:ids.DB, generation:'1', profile });
  let primaryNoInspectLoads = 0;
  await cacheD1Read(primaryWithoutInspection, { key:'primary-noinspect', scope:'a' }, async () => ++primaryNoInspectLoads);
  await cacheD1Read(primaryWithoutInspection, { key:'primary-noinspect', scope:'a' }, async () => ++primaryNoInspectLoads);
  let primaryReads = 0, primaryInspections = 0, primaryLoads = 0;
  const primaryOnly = createD1CacheRuntime(env.DB, { store:{ ...store, read:async (request) => { primaryReads++; return store.read(request); }, inspectFences:async (request) => { primaryInspections++; return store.inspectFences(request); } }, databaseId:ids.DB, generation:'1', profile });
  await cacheD1Read(primaryOnly, { key:'primary-only', scope:'a' }, async () => ++primaryLoads);
  await cacheD1Read(primaryOnly, { key:'primary-only', scope:'a' }, async () => ++primaryLoads);
  let disabledLoads = 0;
  await cacheD1Read(disabled.DB, { key:'off', scope:'a' }, async () => ++disabledLoads);
  await cacheD1Read(disabled.DB, { key:'off', scope:'a' }, async () => ++disabledLoads);
  let failedWriteLoads = 0;
  const failed = createD1CacheRuntime(env.DB, { store:{ ...store, write:async () => { throw Error('offline'); } }, databaseId:ids.DB, generation:'1', profile });
  const failedValue = await cacheD1Read(failed, { key:'failure', scope:'a' }, async () => { failedWriteLoads++; return { ok:true }; });
  let oversizedLoads = 0;
  for (let i=0;i<2;i++) await cacheD1Read(e.DB, { key:'x'.repeat(40000), scope:'a' }, async () => ++oversizedLoads);
  let outageLoads = 0;
  const outage = createD1CacheRuntime(env.OTHER, { store:{ ...otherStore, inspectFences:async () => { throw Error('offline'); } }, databaseId:ids.OTHER, generation:'1', profile });
  for (let i=0;i<2;i++) await cacheD1Read(e.DB, { key:'outage', scope:'a', dependencies:[outage] }, async () => ++outageLoads);
  let oversizeValueLoads = 0;
  for (let i=0;i<2;i++) await cacheD1Read(e.DB, { key:'oversized-value', scope:'a' }, async () => { oversizeValueLoads++; return 'x'.repeat(1600000); });
  let retryLoads = 0;
  try { await cacheD1Read(e.DB, { key:'throws', scope:'a' }, async () => { retryLoads++; throw Error('source'); }); } catch {}
  await cacheD1Read(e.DB, { key:'throws', scope:'a' }, async () => { retryLoads++; return 'ok'; });
  let declinedLoads = 0;
  for (let i=0;i<2;i++) await cacheD1Read(e.DB, { key:'declined', scope:'a', cacheable:() => false }, async () => ++declinedLoads);
  let invalidTtlLoads = 0;
  for (let i=0;i<2;i++) await cacheD1Read(e.DB, { key:'invalid-ttl', scope:'a', ttlMs:0 }, async () => ++invalidTtlLoads);
  let nullLoads = 0;
  for (let i=0;i<2;i++) await cacheD1Read(e.DB, { key:'null', scope:'a' }, async () => { nullLoads++; return null; });
  let typedLoads = 0;
  const typedOptions = { key:['typed', undefined], scope:{ actor:'typed' } };
  const typedLoad = async () => { typedLoads++; return { when:new Date('2026-01-02T03:04:05.000Z'), count:123n, bytes:new Uint8Array([1,2]), values:[undefined] }; };
  await cacheD1Read(e.DB, typedOptions, typedLoad);
  const typed = await cacheD1Read(e.DB, typedOptions, typedLoad);
  const typedResult = { when:typed.when.toISOString(), count:String(typed.count), bytes:Array.from(typed.bytes), undefinedValue:typed.values[0] === undefined };
  let missingDependencyLoads = 0;
  for (let i=0;i<2;i++) await cacheD1Read(e.DB, { key:'missing', scope:'a', dependencies:[env.OTHER] }, async () => ++missingDependencyLoads);
  let jsonLoads = 0;
  const makeJson = () => { jsonLoads++; const body = JSON.stringify({ hello:'world' }); return new Response(body, { status:200, headers:{ 'content-type':'application/json', 'cache-control':'private, no-store', 'vary':'Origin', 'x-result':'ok' } }); };
  const jsonOptions = { key:'json', scope:{ actor:'a' }, buffered:true, request:new Request('https://app.test/data?q=1', { headers:{ Origin:'https://a.test', 'cf-ray':'first-request' } }) };
  const jsonFirst = await cacheD1JsonRead(e.DB, jsonOptions, async () => makeJson());
  const jsonHit = await cacheD1JsonRead(e.DB, { ...jsonOptions, request:new Request('https://app.test/data?q=1', { headers:{ Origin:'https://a.test', 'cf-ray':'second-request' } }) }, async () => makeJson());
  const hitText = await jsonHit.text();
  await cacheD1JsonRead(e.DB, { ...jsonOptions, request:new Request('https://app.test/data?q=1', { headers:{ Origin:'https://b.test' } }) }, async () => makeJson());
  const beforeBypass = jsonLoads;
  const cases = [
    new Request('https://app.test/data', { headers:{ Range:'bytes=0-10' } }),
    new Request('https://app.test/data', { headers:{ 'If-None-Match':'etag' } }),
    new Request('https://app.test/data?preview=1'),
    new Request('https://app.test/capabilities'),
  ];
  for (const req of cases) await cacheD1JsonRead(e.DB, { ...jsonOptions, request:req }, async () => makeJson());
  const badResponse = async (headers, status=200) => { jsonLoads++; return new Response('{}', { status, headers }); };
  for (let i=0;i<2;i++) {
    await cacheD1JsonRead(e.DB, { ...jsonOptions, key:'cookie' }, () => badResponse({ 'content-type':'application/json', 'content-length':'2', 'set-cookie':'a=b' }));
    await cacheD1JsonRead(e.DB, { ...jsonOptions, key:'error' }, () => badResponse({ 'content-type':'application/json', 'content-length':'2' }, 503));
    await cacheD1JsonRead(e.DB, { ...jsonOptions, buffered:undefined, key:'stream' }, () => badResponse({ 'content-type':'application/json' }));
    await cacheD1JsonRead(e.DB, { ...jsonOptions, key:'attachment' }, () => badResponse({ 'content-type':'application/json', 'content-disposition':'attachment' }));
    await cacheD1JsonRead(e.DB, { ...jsonOptions, key:'vary-cookie' }, () => badResponse({ 'content-type':'application/json', 'vary':'Cookie' }));
    await cacheD1JsonRead(e.DB, { ...jsonOptions, key:'oversize-json' }, async () => { jsonLoads++; return new Response('x'.repeat(1000001), { headers:{ 'content-type':'application/json' } }); });
  }
  return Response.json({ first,warm,warmLoads,separated,afterOther,afterPrimary,pendingBypass,primaryPendingBypass,afterRace,current,noInspectLoads,primaryNoInspectLoads,primaryReads,primaryInspections,primaryLoads,disabledLoads,failedWriteLoads,failedValue,oversizedLoads,outageLoads,oversizeValueLoads,retryLoads,declinedLoads,invalidTtlLoads,nullLoads,typedLoads,typedResult,missingDependencyLoads,jsonLoads,beforeBypass,hitText,headers:{ cache:jsonHit.headers.get('cache-control'),vary:jsonHit.headers.get('vary'),result:jsonHit.headers.get('x-result') },firstStatus:jsonFirst.status });
} };`;

it('caches authorized explicit reads across real D1 dependencies and bypasses unsafe JSON responses', async () => {
  const bundle = await build({ stdin: { contents: source, resolveDir: resolve(__dirname, '../../src/d1'), loader:'ts' }, bundle:true, format:'esm', platform:'neutral', target:'es2022', external:['cloudflare:workers'], write:false });
  const output = bundle.outputFiles[0];
  if (!output) throw new Error('D1 read test bundle was not emitted');
  const worker = new Miniflare({ modules:true, script:output.text, compatibilityDate:'2026-01-01', d1Databases:['DB','OTHER'], durableObjects:{ TEST_CACHE_COORDINATOR:{ className:'CacheCoordinator', useSQLite:true } } });
  try {
    for (const [name, value] of [['DB','a1'],['OTHER','b1']] as const) {
      const db = await worker.getD1Database(name);
      await db.batch([db.prepare('CREATE TABLE item (id INTEGER PRIMARY KEY, value TEXT)'), db.prepare('INSERT INTO item VALUES (1, ?)').bind(value)]);
    }
    const response = await worker.dispatchFetch('http://cache.test/');
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ first:{ a:'a1',b:'b1' }, warm:{ a:'a1',b:'b1' }, warmLoads:1, separated:5, afterOther:{ a:'a1',b:'b2' }, afterPrimary:{ a:'a2',b:'b2' }, pendingBypass:1, primaryPendingBypass:1, afterRace:{ a:'a2',b:'b3' }, current:{ a:'a2',b:'b3' }, noInspectLoads:2, primaryNoInspectLoads:1, primaryReads:2, primaryInspections:0, primaryLoads:1, disabledLoads:2, failedWriteLoads:1, failedValue:{ ok:true }, oversizedLoads:2, outageLoads:2, oversizeValueLoads:2, retryLoads:2, declinedLoads:2, invalidTtlLoads:2, nullLoads:2, typedLoads:1, typedResult:{ when:'2026-01-02T03:04:05.000Z', count:'123', bytes:[1,2], undefinedValue:true }, missingDependencyLoads:2, beforeBypass:2, jsonLoads:18, hitText:'{"hello":"world"}', headers:{ cache:'private, no-store', vary:'Origin', result:'ok' }, firstStatus:200 });
  } finally { await worker.dispose(); }
});
