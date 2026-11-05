import { describe, expect, it } from 'vitest';
import { createYandexCacheStore, type CacheDatabase, type CacheRecord } from '../../src/yandex/store';
import { versionedCacheStore } from '../../src/yandex/versioned-store';

function fixture() {
  const rows = new Map<string, CacheRecord>();
  const database: CacheDatabase = {
    async transaction(run) {
      const identity = (kind: string, key: string) => JSON.stringify([kind, key]);
      return run({
        async get(kind, key) { return rows.get(identity(kind, key)) ?? null; },
        async getMany(kind, keys) { return new Map(keys.flatMap(key => { const row = rows.get(identity(kind, key)); return row ? [[key, row] as const] : []; })); },
        async put(kind, record) { rows.set(identity(kind, record.key), record); },
        async delete(kind, key) { rows.delete(identity(kind, key)); },
        async expired(kind, time, limit) { return [...rows].filter(([key, row]) => JSON.parse(key)[0] === kind && row.expiresAt > 0 && row.expiresAt <= time).map(([, row]) => row).slice(0, limit); },
      });
    },
  };
  let version = 'one';
  let count = 0;
  let changeAt = 0;
  const store = versionedCacheStore(createYandexCacheStore(database, { maxStoredBytes: 1_000_000 }), async () => {
    if (++count === changeAt) version = 'two';
    return [['site', version]];
  });
  return { store, change: () => { version = 'two'; }, changeOnNextVerification: () => { changeAt = count + 2; } };
}

const request = { key: 'entry', fences: ['g'], lockMs: 10000, refresh: false };
describe('Yandex cache database versions', () => {
  it('rejects a fill if a database commits after the source read', async () => {
    const { store, change } = fixture();
    const fill = await store.read(request);
    if (fill.kind !== 'miss' || !fill.lockToken) throw new Error('Missing fill lock');
    change();
    expect(await store.write({ key: request.key, lockToken: fill.lockToken, snapshot: fill.epochs, value: 'old', ttlMs: 10000, softTtlMs: 10000 })).toEqual({ ok: false, reason: 'fence' });
  });
  it('rejects a cached hit when a commit races its version verification', async () => {
    const { store, changeOnNextVerification } = fixture();
    const fill = await store.read(request);
    if (fill.kind !== 'miss' || !fill.lockToken) throw new Error('Missing fill lock');
    expect(await store.write({ key: request.key, lockToken: fill.lockToken, snapshot: fill.epochs, value: 'old', ttlMs: 10000, softTtlMs: 10000 })).toEqual({ ok: true });
    changeOnNextVerification();
    expect(await store.read(request)).toMatchObject({ kind: 'miss', pending: true, lockToken: null });
  });
});
