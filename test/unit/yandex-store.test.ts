import { describe, expect, it } from 'vitest';
import { createYandexCacheStore, type CacheDatabase, type CacheRecord } from '../../src/yandex/store';

function fixture() {
  let records = new Map<string, CacheRecord>();
  let tail = Promise.resolve();
  let clock = 1000;
  let serial = 0;
  const database: CacheDatabase = {
    transaction(run) {
      const operation = tail.then(async () => {
        const next = new Map(records);
        const identity = (kind: string, key: string) => JSON.stringify([kind, key]);
        const result = await run({
          async get(kind, key) { return next.get(identity(kind, key)) ?? null; },
          async getMany(kind, keys) { return new Map(keys.flatMap(key => { const row = next.get(identity(kind, key)); return row ? [[key, row] as const] : []; })); },
          async put(kind, record) { next.set(identity(kind, record.key), { ...record }); },
          async delete(kind, key) { next.delete(identity(kind, key)); },
          async expired(kind, time, limit) { return [...next].filter(([key, row]) => JSON.parse(key)[0] === kind && row.expiresAt > 0 && row.expiresAt <= time).map(([, row]) => row).sort((a, b) => a.expiresAt - b.expiresAt).slice(0, limit); },
        });
        records = next;
        return result;
      });
      tail = operation.then(() => {}, () => {});
      return operation;
    },
  };
  const store = createYandexCacheStore(database, { maxStoredBytes: 1024 * 1024, now: () => clock, newToken: () => `token-${++serial}` });
  return { store, database, advance: (ms: number) => { clock += ms; } };
}

describe('Yandex cache store transaction contract', () => {
  it('retains unrelated entries and invalidates changed dependencies', async () => {
    const { store } = fixture();
    const read = () => store.read({ key: 'one', fences: ['g', 'm:one'], lockMs: 1000, refresh: false });
    const miss = await read();
    expect(miss.kind).toBe('miss');
    if (miss.kind !== 'miss' || !miss.lockToken) throw new Error('Missing fill lock');
    expect(await store.write({ key: 'one', lockToken: miss.lockToken, snapshot: miss.epochs, ttlMs: 10000, softTtlMs: 5000, value: 'value' })).toEqual({ ok: true });
    await store.beginWrite({ token: 'writer', fences: ['m:other'], leaseMs: 1000 });
    expect((await read()).kind).toBe('hit');
    expect((await store.inspectFences?.({ fences: ['m:other'] }))?.pending).toBe(true);
    await store.endWrite({ token: 'writer', fences: ['m:other'] });
    expect((await read()).kind).toBe('hit');
    await store.beginWrite({ token: 'writer2', fences: ['m:one'], leaseMs: 1000 });
    const during = await read();
    expect(during).toMatchObject({ kind: 'miss', pending: true, lockToken: null });
    await store.endWrite({ token: 'writer2', fences: ['m:one'] });
    expect((await read()).kind).toBe('miss');
  });

  it('refuses stale fill and expired locks without accepting a partial write', async () => {
    const { store, advance } = fixture();
    const first = await store.read({ key: 'one', fences: ['g', 'm:one'], lockMs: 1000, refresh: false });
    if (first.kind !== 'miss' || !first.lockToken) throw new Error('Missing fill lock');
    await store.invalidate(['m:one']);
    expect(await store.write({ key: 'one', lockToken: first.lockToken, snapshot: first.epochs, ttlMs: 10000, softTtlMs: 5000, value: 'stale' })).toEqual({ ok: false, reason: 'fence' });
    const second = await store.read({ key: 'one', fences: ['g', 'm:one'], lockMs: 1000, refresh: false });
    if (second.kind !== 'miss' || !second.lockToken) throw new Error('Missing fill lock');
    advance(1001);
    expect(await store.write({ key: 'one', lockToken: second.lockToken, snapshot: second.epochs, ttlMs: 10000, softTtlMs: 5000, value: 'late' })).toEqual({ ok: false, reason: 'lock' });
    expect((await store.read({ key: 'one', fences: ['g', 'm:one'], lockMs: 1000, refresh: false })).kind).toBe('miss');
  });

  it('never accepts or serves a same-epoch fill while a dependency lease is pending', async () => {
    const { store, database } = fixture();
    const request = { key: 'one', fences: ['g', 'm:one'], lockMs: 10000, refresh: false };
    const before = await store.read(request);
    if (before.kind !== 'miss' || !before.lockToken) throw new Error('Missing fill lock');
    await store.beginWrite({ token: 'writer', fences: ['m:one'], leaseMs: 10000 });
    const current = await store.inspectFences?.({ fences: request.fences });
    if (!current) throw new Error('Missing fence inspection');
    expect(await store.write({ key: request.key, lockToken: before.lockToken, snapshot: current.epochs, ttlMs: 10000, softTtlMs: 5000, value: 'premature' })).toEqual({ ok: false, reason: 'fence' });
    await database.transaction(async tx => {
      const stored = await tx.get('meta', 'state');
      if (!stored) throw new Error('Missing cache metadata');
      const meta = JSON.parse(stored.value);
      const entry = { value: 'premature', snapshot: current.epochs, softExpires: 6000, expires: 11000, bytes: 9, gc: meta.gc };
      await tx.put('entry', { key: request.key, value: JSON.stringify(entry), expiresAt: entry.expires });
      await tx.put('meta', { key: 'state', value: JSON.stringify({ ...meta, entries: meta.entries + 1, bytes: meta.bytes + entry.bytes }), expiresAt: 0 });
    });
    expect(await store.read({ ...request, fences: ['g'] })).toMatchObject({ kind: 'miss', pending: true, lockToken: null });
  });
});
