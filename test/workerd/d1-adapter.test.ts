import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { resolve } from 'node:path';

const source = `
import { fenceD1Writes } from './adapter';
import { createDurableObjectStore } from '../cloudflare/store';
export { CacheCoordinator } from '../cloudflare/coordinator';
export default { async fetch(request, env) {
  const store = createDurableObjectStore(env.COORDINATOR, { name:'app:db' });
  const db = fenceD1Writes(env.DB, { store, generation:'1', policy: { unfencedWriteTables:['heartbeat'] } });
  const read = () => store.read({ key:'k', generation:'1', fences:['g'], lockMs:30000, refresh:false });
  const invalidated = async () => { const result = await read(); if (result.kind === 'miss' && result.lockToken) await store.release({ key:'k', lockToken:result.lockToken }); return result; };
  const fill = async () => { const miss = await read(); if (miss.kind !== 'miss' || !miss.lockToken) throw Error('expected miss'); await store.write({ key:'k', lockToken:miss.lockToken, snapshot:miss.epochs, ttlMs:60000, softTtlMs:60000, value:'cached' }); };
  await fill();
  const before = await read();
  await db.prepare("INSERT INTO heartbeat VALUES ('h','one')").run();
  const afterHeartbeat = await read();
  await db.batch([db.prepare("UPDATE heartbeat SET value='two'"), db.prepare("UPDATE catalogue SET name='mixed' WHERE id='1'")]);
  const afterMixed = await invalidated();
  await fill();
  await db.withSession().prepare("UPDATE catalogue SET name='session' WHERE id='1'").run();
  const afterSession = await invalidated();
  await fill();
  await db.prepare("WITH x AS (SELECT 'h' AS id) UPDATE heartbeat SET value='cte' WHERE id IN (SELECT id FROM x)").run();
  const afterCte = await invalidated();
  await fill();
  await db.batch([env.DB.prepare("UPDATE heartbeat SET value='foreign'")]);
  const afterForeign = await invalidated();
  await fill();
  await db.exec("UPDATE unknown_writer SET value='changed'");
  const afterUnknown = await invalidated();
  let rejected = false;
  const broken = fenceD1Writes(env.DB, { store: { ...store, beginWrite: async () => { throw Error('offline'); } }, generation:'1', policy:{ unfencedWriteTables:['heartbeat'] } });
  try { await broken.prepare("UPDATE catalogue SET name='unsafe'").run(); } catch { rejected = true; }
  let rolledBack = false;
  try { await db.batch([db.prepare("UPDATE catalogue SET name='bad' WHERE id='1'"), db.prepare("INSERT INTO catalogue VALUES ('1','duplicate')")]); } catch { rolledBack = true; }
  const final = await db.prepare('SELECT name FROM catalogue WHERE id = ?').bind('1').first();
  await env.DB.prepare("UPDATE catalogue SET name='external' WHERE id='1'").run();
  const freshRaw = await db.prepare('SELECT name FROM catalogue WHERE id = ?').bind('1').first();
  const readonly = await broken.prepare("SELECT replace(name, 'external', 'safe') AS name FROM catalogue WHERE id='1'").first();
  return Response.json({ before:before.kind, afterHeartbeat:afterHeartbeat.kind, afterMixed:afterMixed.kind, afterSession:afterSession.kind, afterCte:afterCte.kind, afterForeign:afterForeign.kind, afterUnknown:afterUnknown.kind, rejected, rolledBack, final, freshRaw, readonly });
} };`;

it('fences raw mutations and preserves unrelated writes on real D1 and a real coordinator', async () => {
  const bundle = await build({ stdin: { contents: source, resolveDir: resolve(__dirname, '../../src/d1'), loader: 'ts' }, bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', external: ['cloudflare:workers'], write: false });
  const worker = new Miniflare({ modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: '2026-01-01', d1Databases: ['DB'], durableObjects: { COORDINATOR: { className: 'CacheCoordinator', useSQLite: true } } });
  try {
    const db = await worker.getD1Database('DB');
    await db.batch([db.prepare('CREATE TABLE catalogue (id TEXT PRIMARY KEY, name TEXT)'), db.prepare('CREATE TABLE heartbeat (id TEXT PRIMARY KEY, value TEXT)'), db.prepare('CREATE TABLE unknown_writer (id TEXT PRIMARY KEY, value TEXT)'), db.prepare("INSERT INTO catalogue VALUES ('1','before')"), db.prepare("INSERT INTO unknown_writer VALUES ('u','before')")]);
    const response = await worker.dispatchFetch('http://cache.test/');
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ before:'hit', afterHeartbeat:'hit', afterMixed:'miss', afterSession:'miss', afterCte:'miss', afterForeign:'miss', afterUnknown:'miss', rejected:true, rolledBack:true, final:{ name:'session' }, freshRaw:{ name:'external' }, readonly:{ name:'safe' } });
  } finally { await worker.dispose(); }
});
