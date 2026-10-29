import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { resolve } from 'node:path';

const source = `
import { cacheD1Env } from './env';
import { createDurableObjectStore } from '../cloudflare/store';
const policy = { envPrefix:'CMS_CACHE', bindingNames:['DB'], bindingPrefixes:['SITE_DB_'], coordinatorNamePrefix:'cms:', coordinatorClass:'CacheCoordinator', readModels:['content_model','custom_field','component','language'], unfencedWriteTables:['editor_presence','working_draft','session','verification','instance_setting'] }; 
export { CacheCoordinator } from '@dee-wan/cache/cloudflare';
export default {
  async fetch(request, env) {
    const id = '00000000-0000-0000-0000-000000000001';
    const absent = cacheD1Env(env, policy) === env;
    const disabled = cacheD1Env({ ...env, CMS_CACHE_ENABLED: 'false' }, policy);
    let missing = false;
    try { cacheD1Env({ ...env, CMS_CACHE_ENABLED: 'true' }, policy); } catch { missing = true; }
    let aliasReads = 0;
    const alias = new Proxy(env.DB, { get(target, key) {
      if (key === 'prepare') return (sql) => {
        const wrap = (statement) => new Proxy(statement, { get(stmt, method) {
          if (method === 'bind') return (...args) => wrap(stmt.bind(...args));
          if (method === 'all') return (...args) => { aliasReads++; return stmt.all(...args); };
          const value = stmt[method]; return typeof value === 'function' ? value.bind(stmt) : value;
        }});
        return wrap(target.prepare(sql));
      };
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    }});
    const enabled = { ...env, SITE_DB_alias: alias, CMS_CACHE_ENABLED: 'true', CMS_CACHE_GENERATION: '1',
      CMS_CACHE_DATABASE_IDS: JSON.stringify({ DB: id, SITE_DB_alias: id }) };
    const first = cacheD1Env(enabled, policy);
    const second = cacheD1Env(enabled, policy);
    const store = createDurableObjectStore(env.CMS_CACHE_COORDINATOR, { name: 'cms:' + id, locationHint: 'weur' });
    const miss = await store.read({ key:'fixture', fences:['g'], generation:'1', lockMs:30000, refresh:false });
    if (miss.kind !== 'miss' || !miss.lockToken) throw Error('expected an available fixture fill lock');
    const seeded = await store.write({ key:'fixture', lockToken:miss.lockToken, snapshot:miss.epochs, ttlMs:60000, softTtlMs:60000, value:'cached' });
    if (!seeded.ok) throw Error('fixture cache entry was not committed');
    const bypass = cacheD1Env({ ...enabled, CMS_CACHE_READS_ENABLED: 'false' }, policy);
    let invalidReadsFlag = false;
    try { cacheD1Env({ ...enabled, CMS_CACHE_READS_ENABLED: 'invalid' }, policy); } catch { invalidReadsFlag = true; }
    const query = 'SELECT id, site_id, slug FROM content_model WHERE site_id = ?';
    const before = await first.DB.prepare(query).bind('a').all();
    await first.DB.prepare(query).bind('a').all();
    const beforeWrite = await store.read({ key:'fixture', fences:['g'], generation:'1', lockMs:30000, refresh:false });
    await bypass.SITE_DB_alias.prepare(query).bind('a').all();
    await bypass.SITE_DB_alias.prepare(query).bind('a').all();
    await bypass.SITE_DB_alias.prepare("UPDATE content_model SET slug='changed' WHERE id='1'").run();
    const after = await first.DB.prepare(query).bind('a').all();
    const afterWrite = await store.read({ key:'fixture', fences:['g'], generation:'1', lockMs:30000, refresh:false });
    return Response.json({ beforeWrite: beforeWrite.kind, afterWrite: afterWrite.kind, absent, disabled: disabled.DB === env.DB, missing,
      reused: first.DB === second.DB && first.SITE_DB_alias === second.SITE_DB_alias, differentModes: first.DB !== bypass.DB, aliasReads, invalidReadsFlag, before, after });
  }
};`;

it('wires optional, disabled, required and alias configurations through the real coordinator', async () => {
  const bundle = await build({ stdin: { contents: source, resolveDir: resolve(__dirname, '../../src/d1'), loader: 'ts' }, bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', external: ['cloudflare:workers'], write: false });
  const output = bundle.outputFiles[0];
  if (!output) throw new Error('D1 environment test bundle was not emitted');
  const worker = new Miniflare({ modules: true, script: output.text, compatibilityDate: '2026-01-01', d1Databases: ['DB'], durableObjects: { CMS_CACHE_COORDINATOR: { className: 'CacheCoordinator', useSQLite: true } } });
  try {
    const db = await worker.getD1Database('DB');
    await db.batch([
      db.prepare('CREATE TABLE content_model (id TEXT PRIMARY KEY, site_id TEXT, slug TEXT)'),
      db.prepare("INSERT INTO content_model VALUES ('1', 'a', 'before')"),
    ]);
    const response = await worker.dispatchFetch('http://cache.test/');
    expect(response.status, await response.clone().text()).toBe(200);
    const result = await response.json() as { absent: boolean; disabled: boolean; missing: boolean; reused: boolean; differentModes: boolean; aliasReads: number; invalidReadsFlag: boolean; beforeWrite: string; afterWrite: string; before: { results: { slug: string }[] }; after: { results: { slug: string }[] } };
    expect(result).toMatchObject({ absent: true, disabled: true, missing: true, reused: true, differentModes: true, aliasReads: 2, invalidReadsFlag: true, beforeWrite: 'hit', afterWrite: 'miss' });
    expect(result.before.results[0]?.slug).toBe('before');
    expect(result.after.results[0]?.slug).toBe('changed');
  } finally {
    await worker.dispose();
  }
});
