import { afterEach, describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { createCoordinatorCore, migrate, type Row } from '../../src/cloudflare/coordinator-core';
import { sha256Hex, stableStringify } from '../../src/core/codec';
import { MAX_TTL_MS } from '../../src/core/limits';
import type { CacheStore } from '../../src/core/types';
import { createD1CacheRuntime } from '../../src/d1/env';
import { cacheD1JsonRead } from '../../src/d1/json-read';
import { cacheD1Read, type D1ReadOptions } from '../../src/d1/read';
import { yandexCacheRead } from '../../src/yandex/read';
import { createYandexCacheStore, type CacheDatabase, type CacheRecord } from '../../src/yandex/store';
import { memorySql } from './sqlite';

const day = 86400000;
const profile = { envPrefix: 'TEST', bindingNames: ['DB'], bindingPrefixes: [], coordinatorNamePrefix: 'test:', coordinatorClass: 'CacheCoordinator', readModels: [], unfencedWriteTables: [] };
const unused = (): never => { throw new Error('Unexpected database access'); };
type Kind = 'd1' | 'yandex';
type Fixture = {
  store: CacheStore;
  database?: D1Database;
  read: <T>(options: D1ReadOptions<T>, load: () => Promise<T>) => Promise<T>;
  close: () => void;
};

function fixture(kind: Kind, id = 'db'): Fixture {
  const sql = memorySql();
  if (kind === 'd1') {
    migrate(sql, sql.transact);
    const core = createCoordinatorCore(sql, () => crypto.randomUUID(), sql.transact);
    const store: CacheStore = {
      inspectFences: async (request) => core.inspectFences(request, Date.now()),
      beginWrite: async (request) => { core.beginWrite(request, Date.now()); },
      endWrite: async (request) => { core.endWrite(request, Date.now()); },
      invalidate: async (fences) => { core.invalidate(fences, Date.now()); },
      read: async (request) => core.read(request, Date.now()),
      release: async (request) => { core.release(request); },
      write: async (request) => core.write(request, Date.now()),
    };
    const binding: D1Database = { exec: unused, prepare: unused, batch: unused, withSession: unused, dump: unused };
    const database = createD1CacheRuntime(binding, { store, databaseId: id, generation: '1', regionalIdentity: id, coordinatorName: `test:${id}`, profile });
    return { store, database, read: (options, load) => cacheD1Read(database, options, load), close: () => sql.close() };
  }
  sql.exec('CREATE TABLE cache_record(kind TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(kind,key))');
  const record = (row: Row | undefined): CacheRecord | null => {
    if (!row) return null;
    if (typeof row.key !== 'string' || typeof row.value !== 'string' || typeof row.expiresAt !== 'number') throw new Error('Invalid stored cache record');
    return { key: row.key, value: row.value, expiresAt: row.expiresAt };
  };
  const get = (kind: string, key: string) => record(sql.all('SELECT key,value,expires_at AS expiresAt FROM cache_record WHERE kind=? AND key=?', kind, key)[0]);
  let tail = Promise.resolve();
  const database: CacheDatabase = {
    transaction(run) {
      const operation = tail.then(async () => {
        sql.exec('BEGIN');
        try {
          const result = await run({
            get: async (kind, key) => get(kind, key),
            getMany: async (kind, keys) => {
              const result = new Map<string, CacheRecord>();
              for (const key of keys) { const value = get(kind, key); if (value) result.set(key, value); }
              return result;
            },
            put: async (kind, value) => { sql.exec('INSERT INTO cache_record(kind,key,value,expires_at) VALUES(?,?,?,?) ON CONFLICT(kind,key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at', kind, value.key, value.value, value.expiresAt); },
            delete: async (kind, key) => { sql.exec('DELETE FROM cache_record WHERE kind=? AND key=?', kind, key); },
            expired: async (kind, now, limit) => sql.all('SELECT key,value,expires_at AS expiresAt FROM cache_record WHERE kind=? AND expires_at>0 AND expires_at<=? ORDER BY expires_at,key LIMIT ?', kind, now, limit).flatMap((row) => { const value = record(row); return value ? [value] : []; }),
          });
          sql.exec('COMMIT');
          return result;
        } catch (error) { sql.exec('ROLLBACK'); throw error; }
      });
      tail = operation.then(() => {}, () => {});
      return operation;
    },
  };
  const store = createYandexCacheStore(database, { maxStoredBytes: 1_000_000, now: () => Date.now(), newToken: () => crypto.randomUUID() });
  return { store, read: (options, load) => yandexCacheRead(store, options, load), close: () => sql.close() };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe.each<Kind>(['d1', 'yandex'])('%s explicit read TTL policy', (kind) => {
  it('retains the default five-minute ceiling without touching the coordinator for a day-long TTL', async () => {
    const f = fixture(kind);
    const read = vi.spyOn(f.store, 'read');
    const load = vi.fn(async () => 0);
    try {
      const options = { key: 'score', scope: 'scope', ttlMs: day, ttlJitterRatio: 0 };
      expect(await f.read(options, load)).toBe(0);
      expect(await f.read(options, load)).toBe(0);
      expect(load).toHaveBeenCalledTimes(2);
      expect(read).not.toHaveBeenCalled();
    } finally { f.close(); }
  });

  it('caches a real zero until the explicit day boundary, then reloads', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1000);
    const f = fixture(kind);
    const load = vi.fn<() => Promise<number>>().mockResolvedValueOnce(0).mockResolvedValue(19);
    try {
      const options = { key: 'score', scope: 'scope', ttlMs: day, maxTtlMs: day, ttlJitterRatio: 0 };
      expect(await f.read(options, load)).toBe(0);
      vi.setSystemTime(1000 + day - 1);
      expect(await f.read(options, load)).toBe(0);
      expect(load).toHaveBeenCalledTimes(1);
      vi.setSystemTime(1000 + day);
      expect(await f.read(options, load)).toBe(19);
      expect(load).toHaveBeenCalledTimes(2);
    } finally { f.close(); }
  });

  it('separates default, explicit maxima and requested TTL ceiling identities', async () => {
    const f = fixture(kind);
    const source = vi.fn(async () => 7);
    try {
      const base = { key: 'same', scope: 'scope', ttlMs: 300000, ttlJitterRatio: 0 };
      const long = { ...base, ttlMs: day, maxTtlMs: day };
      const other = { ...long, maxTtlMs: 2 * day };
      const shorter = { ...long, ttlMs: 1000 };
      expect(await f.read(base, source)).toBe(7);
      expect(await f.read(long, async () => 0)).toBe(0);
      expect(await f.read(other, async () => 11)).toBe(11);
      expect(await f.read(shorter, async () => 3)).toBe(3);
      expect(await f.read(base, source)).toBe(7);
      expect(await f.read(long, source)).toBe(0);
      expect(await f.read(other, source)).toBe(11);
      expect(await f.read(shorter, source)).toBe(3);
      expect(source).toHaveBeenCalledTimes(1);
    } finally { f.close(); }
  });

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_TTL_MS + 1])('bypasses invalid explicit ceiling %s', async (maxTtlMs) => {
    const f = fixture(kind);
    const read = vi.spyOn(f.store, 'read');
    const load = vi.fn(async () => 0);
    try {
      const options = { key: 'score', scope: 'scope', ttlMs: 1000, maxTtlMs };
      await f.read(options, load);
      await f.read(options, load);
      expect(load).toHaveBeenCalledTimes(2);
      expect(read).not.toHaveBeenCalled();
    } finally { f.close(); }
  });

  it('bypasses a TTL beyond an otherwise valid explicit ceiling', async () => {
    const f = fixture(kind);
    const read = vi.spyOn(f.store, 'read');
    try {
      expect(await f.read({ key: 'score', scope: 'scope', ttlMs: 1001, maxTtlMs: 1000 }, async () => 0)).toBe(0);
      expect(read).not.toHaveBeenCalled();
    } finally { f.close(); }
  });

  it('accepts the existing store protocol upper bound', async () => {
    const f = fixture(kind);
    const load = vi.fn(async () => 0);
    try {
      const options = { key: 'score', scope: 'scope', ttlMs: MAX_TTL_MS, maxTtlMs: MAX_TTL_MS, ttlJitterRatio: 0 };
      expect(await f.read(options, load)).toBe(0);
      expect(await f.read(options, load)).toBe(0);
      expect(load).toHaveBeenCalledTimes(1);
    } finally { f.close(); }
  });

  it('retains the omitted-option coordinator key exactly', async () => {
    const f = fixture(kind);
    const read = vi.spyOn(f.store, 'read');
    try {
      await f.read({ key: 'score', scope: 'scope', ttlMs: 1000, ttlJitterRatio: 0 }, async () => 0);
      const identity = kind === 'd1' ? ['d1-read-v1', null, 'db', '1', 'scope', 'score', []] : ['scope', 'score'];
      expect(read.mock.calls[0]?.[0].key).toBe(`${kind === 'd1' ? 'd1' : 'read'}:${await sha256Hex(stableStringify(identity))}`);
    } finally { f.close(); }
  });

  it('keeps invalidation and pending-write fences for long-lived values', async () => {
    const f = fixture(kind);
    const options = { key: 'score', scope: 'scope', ttlMs: day, maxTtlMs: day, ttlJitterRatio: 0 };
    try {
      expect(await f.read(options, async () => 0)).toBe(0);
      await f.store.invalidate(['g']);
      expect(await f.read(options, async () => 4)).toBe(4);
      await f.store.beginWrite({ fences: ['g'], token: 'writer', leaseMs: 1000, ...(kind === 'd1' ? { generation: '1' } : {}) });
      expect(await f.read(options, async () => 8)).toBe(8);
      expect(await f.read(options, async () => 9)).toBe(9);
      await f.store.endWrite({ fences: ['g'], token: 'writer' });
      expect(await f.read(options, async () => 10)).toBe(10);
      expect(await f.read(options, async () => 11)).toBe(10);
    } finally { f.close(); }
  });

  it.each([undefined, day])('keeps outage local-fill ownership separate with follower maximum %s', async (maxTtlMs) => {
    const f = fixture(kind);
    vi.spyOn(f.store, 'read').mockRejectedValue(new Error('Coordinator unavailable'));
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const first = f.read({ key: 'score', scope: 'scope', ttlMs: day, maxTtlMs: day }, async () => { entered(); await held; return 0; });
    try {
      await started;
      const second = f.read({ key: 'score', scope: 'scope', ttlMs: 300000, maxTtlMs }, async () => 7);
      try { expect(await second).toBe(7); } finally { release(); }
      expect(await first).toBe(0);
    } finally { release(); try { await first; } finally { f.close(); } }
  });
});

it('keeps explicit D1 TTL policies separate in regional cache', async () => {
  const entries = new Map<string, Response>();
  vi.stubGlobal('caches', { default: {
    match: async (key: string) => entries.get(key)?.clone(),
    put: async (key: string, value: Response) => { entries.set(key, value.clone()); },
  } });
  const f = fixture('d1');
  const read = vi.spyOn(f.store, 'read');
  try {
    const base = { key: 'score', scope: 'scope', ttlMs: 300000, regionalTtlMs: 5000, ttlJitterRatio: 0 };
    const long = { ...base, ttlMs: day, maxTtlMs: day };
    const other = { ...long, maxTtlMs: 2 * day };
    const shorter = { ...long, ttlMs: 60000 };
    expect(await f.read(long, async () => 0)).toBe(0);
    expect(await f.read(base, async () => 7)).toBe(7);
    expect(await f.read(other, async () => 11)).toBe(11);
    expect(await f.read(shorter, async () => 3)).toBe(3);
    expect(read).toHaveBeenCalledTimes(4);
    const unusedSource = async (): Promise<number> => { throw new Error('Expected regional hit'); };
    expect(await f.read(long, unusedSource)).toBe(0);
    expect(await f.read(base, unusedSource)).toBe(7);
    expect(await f.read(other, unusedSource)).toBe(11);
    expect(await f.read(shorter, unusedSource)).toBe(3);
    expect(read).toHaveBeenCalledTimes(4);
  } finally { f.close(); }
});

it('retains D1 dependency fencing under an explicit long TTL', async () => {
  const primary = fixture('d1', 'primary');
  const dependency = fixture('d1', 'dependency');
  if (!dependency.database) throw new Error('Missing dependency database');
  const options = { key: 'score', scope: 'scope', dependencies: [dependency.database], ttlMs: day, maxTtlMs: day, ttlJitterRatio: 0 };
  try {
    expect(await primary.read(options, async () => 0)).toBe(0);
    await dependency.store.beginWrite({ fences: ['g'], generation: '1', leaseMs: 1000, token: 'writer' });
    expect(await primary.read(options, async () => 3)).toBe(3);
    await dependency.store.endWrite({ fences: ['g'], token: 'writer' });
    expect(await primary.read(options, async () => 4)).toBe(4);
    expect(await primary.read(options, async () => 5)).toBe(4);
  } finally { primary.close(); dependency.close(); }
});

it('forwards the explicit TTL policy through buffered D1 JSON reads', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1000);
  const f = fixture('d1');
  if (!f.database) throw new Error('Missing database');
  const database = f.database;
  const options = { key: 'score', scope: 'scope', request: new Request('https://app.test/rating'), buffered: true, ttlMs: day, maxTtlMs: day } satisfies Parameters<typeof cacheD1JsonRead>[1];
  const load = vi.fn(async () => Response.json({ rating: 0 }));
  try {
    expect(await (await cacheD1JsonRead(database, options, load)).json()).toEqual({ rating: 0 });
    vi.setSystemTime(1000 + 3600000);
    expect(await (await cacheD1JsonRead(database, options, load)).json()).toEqual({ rating: 0 });
    expect(load).toHaveBeenCalledTimes(1);
    await cacheD1JsonRead(database, { ...options, maxTtlMs: undefined }, load);
    expect(load).toHaveBeenCalledTimes(2);
  } finally { f.close(); }
});

it.each([
  { name: 'default', ttlMs: 300000, maxTtlMs: undefined },
  { name: 'shorter requested TTL', ttlMs: 300000, maxTtlMs: day },
  { name: 'different explicit maximum', ttlMs: day, maxTtlMs: 2 * day },
])('separates D1 dependency-outage local ownership for $name', async (follower) => {
  const primary = fixture('d1', 'primary');
  const dependency = fixture('d1', 'dependency');
  if (!dependency.database) throw new Error('Missing dependency database');
  const unavailable = createD1CacheRuntime(dependency.database, {
    store: { ...dependency.store, inspectFences: async () => { throw new Error('Dependency unavailable'); } },
    databaseId: 'unavailable', generation: '1', profile,
  });
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const options = { key: 'score', scope: 'scope', dependencies: [unavailable], ttlMs: day, maxTtlMs: day };
  const first = primary.read(options, async () => { entered(); await held; return 0; });
  try {
    await started;
    const second = primary.read({ ...options, ttlMs: follower.ttlMs, maxTtlMs: follower.maxTtlMs }, async () => 7);
    try { expect(await second).toBe(7); } finally { release(); }
    expect(await first).toBe(0);
  } finally { release(); try { await first; } finally { primary.close(); dependency.close(); } }
});
