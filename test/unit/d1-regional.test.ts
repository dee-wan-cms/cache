import { afterEach, expect, it, vi } from 'vitest';
import { regionalKey, regionalRead, regionalWrite } from '../../src/d1/regional';

const entries = new Map<string, Response>();
const cache = {
  match: vi.fn(async (key: string) => entries.get(key)?.clone()),
  put: vi.fn(async (key: string, value: Response) => { entries.set(key, value.clone()); }),
};
vi.stubGlobal('caches', { default: cache });
afterEach(() => { entries.clear(); vi.clearAllMocks(); vi.useRealTimers(); });

it('bounds age from the start and isolates identities', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  const key = await regionalKey(5000, ['database', 'actor']);
  const other = await regionalKey(5000, ['database', 'other']);
  expect(key).not.toEqual(other);
  await regionalWrite(key, 5000, Date.now(), { value: 1 });
  expect((await regionalRead(key))?.value).toEqual({ value: 1 });
  expect(await regionalRead(other)).toBeNull();
  vi.setSystemTime(105_000);
  expect(await regionalRead(key)).toBeNull();
  await regionalWrite(other, 5000, 100_000, { value: 2 });
  expect(await regionalRead(other)).toBeNull();
});

it('rejects bad limits, corrupt data and cache failures', async () => {
  expect(await regionalKey(0, 'x')).toBeNull();
  expect(await regionalKey(5001, 'x')).toBeNull();
  const key = await regionalKey(5000, 'x');
  if (!key) throw new Error('missing key');
  entries.set(key, new Response('invalid'));
  expect(await regionalRead(key)).toBeNull();
  cache.match.mockRejectedValueOnce(new Error('unavailable'));
  expect(await regionalRead(key)).toBeNull();
  cache.put.mockRejectedValueOnce(new Error('unavailable'));
  await expect(regionalWrite(key, 5000, Date.now(), 1)).resolves.toBeUndefined();
  await regionalWrite(key, 5000, Date.now(), 'x'.repeat(1_600_000));
  expect(cache.put).toHaveBeenCalledTimes(1);
});

it('does not admit null, nonserializable, or an expired overtaken fill', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  const key = await regionalKey(5000, 'race');
  await regionalWrite(key, 5000, 100_000, null);
  await regionalWrite(key, 5000, 100_000, () => 1);
  expect(cache.put).not.toHaveBeenCalled();
  vi.setSystemTime(104_000);
  await regionalWrite(key, 5000, 104_000, 'new');
  vi.setSystemTime(105_000);
  await regionalWrite(key, 5000, 100_000, 'old');
  expect((await regionalRead(key))?.value).toBe('new');
});

import type { D1Database } from '@cloudflare/workers-types';
import type { CacheStore, GeneratedCacheConfig, ReadResponse } from '../../src/core/types';
import { CONFIG_FORMAT } from '../../src/core/limits';
import { createD1CacheRuntime, d1PrismaCacheExtension } from '../../src/d1/env';
import { cacheD1Read } from '../../src/d1/read';

const profile = { envPrefix:'TEST', bindingNames:['DB'], bindingPrefixes:[], coordinatorNamePrefix:'test:', coordinatorClass:'CacheCoordinator', readModels:['Meta', 'Secret'], unfencedWriteTables:[] };
const config: GeneratedCacheConfig = {
  cacheVersion:'1', configFormat:CONFIG_FORMAT, hasDecimalFields:false,
  modelNames:['Meta', 'Secret'], cacheableByModel:{ Meta:true, Secret:true },
  primaryKeyFieldsByModel:{ Meta:['id'], Secret:['id'] }, primaryKeyNameByModel:{},
  relationGraph:{ Meta:[{ fieldName:'secret', targetModel:'Secret', relationName:'secret', foreignFields:[], localFields:[], isList:false, oneToOne:false }] },
};
const unused = (): never => { throw new Error('unused'); };
const binding: D1Database = { exec:unused, prepare:unused, batch:unused, withSession:unused, dump:unused };
const miss: ReadResponse = { kind:'miss', epochs:{ g:0 }, lockHeldForMs:null, lockToken:'lock', pending:false };
function fixture() {
  let state: 'ok' | 'pending' | 'down' = 'ok';
  let write: 'ok' | 'reject' | 'down' = 'ok';
  const read = vi.fn(async (): Promise<ReadResponse> => miss);
  const inspect = vi.fn(async () => { if (state === 'down') throw Error('down'); return { pending:state === 'pending', epochs:{ g:0 } }; });
  const store: CacheStore = {
    read, release:async () => {}, beginWrite:async () => {}, endWrite:async () => {}, invalidate:async () => {},
    inspectFences:inspect,
    write:async () => { if (write === 'down') throw Error('down'); return write === 'ok' ? { ok:true } : { ok:false, reason:'fence' }; },
  };
  const database = (id = 'db', generation = '1', regionalIdentity = 'coordinator') => createD1CacheRuntime(binding, { store, databaseId:id, generation, regionalIdentity, coordinatorName:`test:${id}`, profile });
  return { store, read, inspect, database, state:(value: typeof state) => { state = value; }, write:(value: typeof write) => { write = value; } };
}

it('uses warm regional values without coordination and isolates actor, database, generation and coordinator', async () => {
  const f = fixture();
  const db = f.database();
  let loads = 0;
  const run = (database: D1Database, scope: string) => cacheD1Read(database, { key:'row', scope, regionalTtlMs:5000 }, async () => ++loads);
  expect(await run(db, 'alice')).toBe(1);
  expect(await run(db, 'alice')).toBe(1);
  expect(f.read).toHaveBeenCalledTimes(1);
  expect(await run(db, 'bob')).toBe(2);
  expect(await run(f.database('other'), 'alice')).toBe(3);
  expect(await run(f.database('db', '2'), 'alice')).toBe(4);
  expect(await run(f.database('db', '1', 'other'), 'alice')).toBe(5);
});

it('does not populate regional cache on pending, unavailable or rejected coordination', async () => {
  const f = fixture();
  const db = f.database();
  const dependency = f.database('other');
  let loads = 0;
  const run = (key: string) => cacheD1Read(db, { key, scope:'actor', dependencies:[dependency], regionalTtlMs:5000 }, async () => ++loads);
  f.state('pending');
  await run('pending');
  f.state('ok');
  expect(await run('pending')).toBe(2);
  f.state('down');
  await run('down');
  f.state('ok');
  expect(await run('down')).toBe(4);
  f.write('reject');
  await run('reject');
  f.write('ok');
  expect(await run('reject')).toBe(6);
  f.write('down');
  await run('write-down');
  f.write('ok');
  expect(await run('write-down')).toBe(8);
});

it('expires slow fills and preserves a newer fill when an old fill finishes after its deadline', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  const f = fixture();
  const db = f.database();
  let release: (() => void) | undefined;
  let reached: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { reached = resolve; });
  const options = { key:'race', scope:'actor', regionalTtlMs:5000 };
  const old = cacheD1Read(db, options, async () => { reached?.(); await waiting; return 'old'; });
  await started;
  vi.setSystemTime(104_000);
  expect(await cacheD1Read(db, options, async () => 'new')).toBe('new');
  vi.setSystemTime(105_000);
  release?.();
  expect(await old).toBe('old');
  expect(await cacheD1Read(db, options, async () => 'unexpected')).toBe('new');
});

it('uses normalized Prisma args and data path while excluding batches and unlisted relations', async () => {
  const f = fixture();
  const db = f.database();
  let queries = 0;
  const extension = d1PrismaCacheExtension(db, config, { scope:'alice', regionalTtlMs:5000, regionalModels:['Meta'], keyArgs: (args) => {
    if (!args || typeof args !== 'object') return args;
    return { where:Reflect.get(args, 'where'), include:Reflect.get(args, 'include') };
  } });
  if (!extension) throw Error('extension missing');
  const run = (args: object, internal: object = {}) => extension.query.$allModels.$allOperations({ model:'Meta', operation:'findMany', args, __internalParams:internal, query:async () => ++queries });
  expect(await run({ where:{ id:1 }, marker:'first' }, { dataPath:['a'] })).toBe(1);
  expect(await run({ where:{ id:1 }, marker:'second' }, { dataPath:['a'] })).toBe(1);
  expect(await run({ where:{ id:1 } }, { dataPath:['b'] })).toBe(2);
  expect(await run({ where:{ id:2 } }, { dataPath:['a'] })).toBe(3);
  expect(await run({ where:{ id:1 } }, { transaction:{ kind:'batch' } })).toBe(4);
  expect(await run({ where:{ id:1 } }, { transaction:{ kind:'batch' } })).toBe(5);
  expect(await run({ where:{ id:1 }, include:{ secret:true } })).toBe(6);
  expect(await run({ where:{ id:1 }, include:{ secret:true } })).toBe(7);
});

it('does not hide source errors or cache a failed source', async () => {
  const f = fixture();
  const db = f.database();
  const options = { key:'failure', scope:'actor', regionalTtlMs:5000 };
  await expect(cacheD1Read(db, options, async () => { throw Error('source'); })).rejects.toThrow('source');
  expect(await cacheD1Read(db, options, async () => 'recovered')).toBe('recovered');
  expect(f.read).toHaveBeenCalledTimes(2);
});


it('does not inspect dependency epochs on a regional hit', async () => {
  const f = fixture();
  const db = f.database();
  const dependency = f.database('other');
  const options = { key:'dependency', scope:'actor', dependencies:[dependency], regionalTtlMs:5000 };
  await cacheD1Read(db, options, async () => 1);
  const calls = f.inspect.mock.calls.length;
  expect(calls).toBeGreaterThan(0);
  expect(await cacheD1Read(db, options, async () => 2)).toBe(1);
  expect(f.inspect).toHaveBeenCalledTimes(calls);
});

it('only promotes a validated Prisma coordinator hit', async () => {
  const f = fixture();
  const db = f.database();
  const extension = d1PrismaCacheExtension(db, config, { scope:'alice', regionalTtlMs:5000 });
  if (!extension) throw Error('extension missing');
  let loads = 0;
  const run = (id: number) => extension.query.$allModels.$allOperations({ model:'Meta', operation:'findMany', args:{ where:{ id } }, query:async () => ++loads });
  f.read.mockResolvedValue({ kind:'hit', epochs:{ g:0 }, refreshToken:null, value:'{"answer":42}' });
  expect(await run(1)).toEqual({ answer:42 });
  f.read.mockRejectedValue(new Error('down'));
  expect(await run(1)).toEqual({ answer:42 });
  f.read.mockResolvedValue({ kind:'hit', epochs:{ g:0 }, refreshToken:null, value:'invalid' });
  expect(await run(2)).toBe(1);
  expect(await run(2)).toBe(2);
});

it('separates dependency identities and generations', async () => {
  const f = fixture();
  const db = f.database();
  let loads = 0;
  const run = (dependency: D1Database) => cacheD1Read(db, { key:'dependent', scope:'actor', dependencies:[dependency], regionalTtlMs:5000 }, async () => ++loads);
  expect(await run(f.database('one'))).toBe(1);
  expect(await run(f.database('one'))).toBe(1);
  expect(await run(f.database('one', '2'))).toBe(2);
  expect(await run(f.database('two'))).toBe(3);
  expect(await run(f.database('one', '1', 'other'))).toBe(4);
});

it('does not promote a primary pending read or an invalid regional envelope', async () => {
  const f = fixture();
  const db = f.database();
  const options = { key:'pending-primary', scope:'actor', regionalTtlMs:5000 };
  f.read.mockResolvedValueOnce({ kind:'miss', epochs:{ g:0 }, lockHeldForMs:null, lockToken:null, pending:true });
  expect(await cacheD1Read(db, options, async () => 1)).toBe(1);
  expect(await cacheD1Read(db, options, async () => 2)).toBe(2);
  expect(f.read).toHaveBeenCalledTimes(2);
  const key = await regionalKey(5000, 'bad-envelope');
  if (!key) throw Error('key missing');
  entries.set(key, new Response(JSON.stringify({ expires:Date.now() + 10_000, value:1 })));
  expect(await regionalRead(key)).toBeNull();
});
