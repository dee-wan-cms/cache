import type { BeginWriteRequest, CacheStore, EndWriteRequest, InspectFencesRequest, ReadRequest, ReleaseRequest, WriteRequest, WriteResult } from '../core/types';
import { MAX_COORDINATOR_GENERATION_LENGTH, MAX_LEASE_MS, MAX_LOCK_MS, MAX_TTL_MS, MAX_VALUE_BYTES } from '../core/limits';

export type CacheRecord = { key: string; value: string; expiresAt: number };
export interface CacheTransaction {
  get(kind: string, key: string): Promise<CacheRecord | null>;
  getMany(kind: string, keys: readonly string[]): Promise<Map<string, CacheRecord>>;
  put(kind: string, record: CacheRecord): Promise<void>;
  delete(kind: string, key: string): Promise<void>;
  expired(kind: string, now: number, limit: number): Promise<CacheRecord[]>;
}
export interface CacheDatabase {
  transaction<T>(run: (tx: CacheTransaction) => Promise<T>): Promise<T>;
}

type Meta = { sequence: number; gc: number; generation: string | null; bytes: number; fences: number; entries: number; locks: number };
type Lease = { token: string; expires: number };
type Fence = { epoch: number; leases: Lease[] };
type Lock = { token: string; expires: number; acquired: number; kind: 'fill' | 'refresh'; gc: number };
type Entry = { value: string; snapshot: Record<string, number>; softExpires: number; expires: number; bytes: number; gc: number };
const MAX_FENCES = 100_000;
const MAX_ENTRIES = 100_000;
const MAX_LOCKS = 100_000;
const MAX_REQUEST_FENCES = 5000;
const RETAIN_FENCE_MS = 2 * MAX_LEASE_MS;
const encoder = new TextEncoder();
const unique = (values: readonly string[]) => [...new Set(values)];
const size = (value: string) => encoder.encode(value).byteLength;
const validString = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const validDuration = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const duration = (value: number, max: number) => Math.min(Math.max(Math.trunc(value), 1), max);
function validFences(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_REQUEST_FENCES && value.every(fence => validString(fence, 512));
}
function validGeneration(value: unknown): value is string | undefined {
  return value === undefined || validString(value, MAX_COORDINATOR_GENERATION_LENGTH);
}
function assert(condition: unknown): asserts condition { if (!condition) throw new TypeError('Invalid Yandex cache request'); }
function parse<T>(record: CacheRecord | null): T | null {
  if (!record) return null;
  const value: unknown = JSON.parse(record.value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Yandex cache record');
  return value as T;
}
function validMeta(meta: Meta): boolean {
  return [meta.sequence, meta.gc, meta.bytes, meta.fences, meta.entries, meta.locks].every(value => Number.isSafeInteger(value) && value >= 0) &&
    (meta.generation === null || typeof meta.generation === 'string');
}
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function fenceRecord(row: CacheRecord | null): Fence | null {
  const fence = parse<Fence>(row);
  if (fence && (!integer(fence.epoch) || !Array.isArray(fence.leases) || fence.leases.some(lease =>
    !lease || typeof lease !== 'object' || !validString(lease.token, 128) || !integer(lease.expires)))) throw new Error('Invalid cache fence');
  return fence;
}
function lockRecord(row: CacheRecord | null): Lock | null {
  const lock = parse<Lock>(row);
  if (lock && (!validString(lock.token, 128) || !integer(lock.expires) || !integer(lock.acquired) || !integer(lock.gc) || !['fill', 'refresh'].includes(lock.kind))) throw new Error('Invalid cache lock');
  return lock;
}
function entryRecord(row: CacheRecord | null): Entry | null {
  const entry = parse<Entry>(row);
  if (entry && (typeof entry.value !== 'string' || !entry.snapshot || typeof entry.snapshot !== 'object' || Array.isArray(entry.snapshot) ||
      Object.keys(entry.snapshot).length > MAX_REQUEST_FENCES || Object.values(entry.snapshot).some(value => !integer(value)) ||
      !integer(entry.softExpires) || !integer(entry.expires) || !integer(entry.bytes) || !integer(entry.gc))) throw new Error('Invalid cache entry');
  return entry;
}

export function createYandexCacheStore(database: CacheDatabase, options: { maxStoredBytes: number; now?: () => number; newToken?: () => string }): CacheStore {
  if (!Number.isSafeInteger(options.maxStoredBytes) || options.maxStoredBytes < 1) throw new Error('Invalid cache capacity');
  const now = options.now ?? Date.now;
  const token = options.newToken ?? (() => crypto.randomUUID());
  const readMeta = async (tx: CacheTransaction): Promise<Meta> => {
    const value = parse<Meta>(await tx.get('meta', 'state')) ?? { sequence: 0, gc: 0, generation: null, bytes: 0, fences: 0, entries: 0, locks: 0 };
    if (!validMeta(value)) throw new Error('Invalid Yandex cache metadata');
    return value;
  };
  const saveMeta = (tx: CacheTransaction, meta: Meta) => {
    if (!validMeta(meta)) throw new Error('Invalid Yandex cache metadata');
    return tx.put('meta', { key: 'state', value: JSON.stringify(meta), expiresAt: 0 });
  };
  const next = (meta: Meta) => { if (meta.sequence >= Number.MAX_SAFE_INTEGER) throw new Error('Cache generation exhausted'); return ++meta.sequence; };
  async function fences(tx: CacheTransaction, names: readonly string[]): Promise<Map<string, Fence>> {
    const rows = await tx.getMany('fence', unique(names));
    const result = new Map<string, Fence>();
    for (const name of unique(names)) {
      const fence = fenceRecord(rows.get(name) ?? null) ?? { epoch: 0, leases: [] };
      result.set(name, fence);
    }
    return result;
  }
  const epochs = (names: readonly string[], values: Map<string, Fence>) => Object.fromEntries(unique(names).map(name => [name, values.get(name)?.epoch ?? 0]));
  const pending = (values: Map<string, Fence>, time: number) => [...values.values()].some(fence => fence.leases.some(lease => lease.expires > time));
  async function sweep(tx: CacheTransaction, meta: Meta, time: number): Promise<void> {
    for (const row of await tx.expired('entry', time, 50)) {
      const entry = entryRecord(row);
      if (!entry || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error('Invalid cache entry');
      await tx.delete('entry', row.key); meta.bytes = Math.max(0, meta.bytes - entry.bytes); meta.entries--;
    }
    for (const row of await tx.expired('lock', time, 50)) { await tx.delete('lock', row.key); meta.locks--; }
    const expiredFences = await tx.expired('fence', time, 50);
    if (expiredFences.length) {
      for (const row of expiredFences) {
        const fence = fenceRecord(row);
        if (!fence || fence.leases.some(lease => lease.expires > time)) continue;
        await tx.delete('fence', row.key); meta.fences--;
      }
      meta.gc = next(meta);
    }
  }
  async function observe(tx: CacheTransaction, meta: Meta, generation: string | undefined, time: number): Promise<boolean> {
    if (generation === undefined || meta.generation === generation) return false;
    const row = await tx.get('fence', 'g');
    if (!row && meta.fences >= MAX_FENCES) await sweep(tx, meta, time);
    if (!row && meta.fences >= MAX_FENCES) throw new Error('Cache fence capacity exceeded');
    const fence = fenceRecord(row) ?? { epoch: 0, leases: [] };
    if (!row) meta.fences++;
    fence.epoch = next(meta);
    await tx.put('fence', { key: 'g', value: JSON.stringify(fence), expiresAt: time + RETAIN_FENCE_MS });
    meta.generation = generation;
    return true;
  }
  async function bump(tx: CacheTransaction, meta: Meta, names: string[], time: number, update: (fence: Fence) => void): Promise<void> {
    const namesUnique = unique(names);
    let rows = await tx.getMany('fence', namesUnique);
    if (meta.fences + namesUnique.filter(name => !rows.has(name)).length > MAX_FENCES) {
      await sweep(tx, meta, time);
      rows = await tx.getMany('fence', namesUnique);
    }
    const current = await fences(tx, namesUnique);
    if (meta.fences + namesUnique.filter(name => !rows.has(name)).length > MAX_FENCES) throw new Error('Cache fence capacity exceeded');
    for (const name of namesUnique) {
      const fence = current.get(name);
      if (!fence) throw new Error('Cache fence unavailable');
      if (!rows.has(name)) meta.fences++;
      fence.epoch = next(meta);
      fence.leases = fence.leases.filter(lease => lease.expires > time);
      update(fence);
      await tx.put('fence', { key: name, value: JSON.stringify(fence), expiresAt: time + RETAIN_FENCE_MS });
    }
  }
  const validSnapshot = (snapshot: unknown): snapshot is Record<string, number> => !!snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) &&
    Object.keys(snapshot).length <= MAX_REQUEST_FENCES && Object.keys(snapshot).every(name => validString(name, 512)) && Object.values(snapshot).every(value => Number.isSafeInteger(value) && value >= 0);
  const matches = (snapshot: Record<string, number>, values: Map<string, Fence>) => Object.keys(snapshot).length > 0 && Object.entries(snapshot).every(([name, epoch]) => (values.get(name)?.epoch ?? 0) === epoch);
  return {
    async inspectFences(request: InspectFencesRequest) {
      assert(validFences(request.fences) && validGeneration(request.generation));
      return database.transaction(async tx => { const time = now(), meta = await readMeta(tx); const changed = await observe(tx, meta, request.generation, time); const values = await fences(tx, request.fences); if (changed) await saveMeta(tx, meta); return { epochs: epochs(request.fences, values), pending: pending(values, time) }; });
    },
    async beginWrite(request: BeginWriteRequest) {
      assert(validFences(request.fences) && validGeneration(request.generation) && validDuration(request.leaseMs) && validString(request.token, 128));
      await database.transaction(async tx => { const time = now(), meta = await readMeta(tx); await observe(tx, meta, request.generation, time); await bump(tx, meta, request.fences, time, fence => { fence.leases = fence.leases.filter(lease => lease.token !== request.token); if (fence.leases.length >= 128) throw new Error('Cache lease capacity exceeded'); fence.leases.push({ token: request.token, expires: time + duration(request.leaseMs, MAX_LEASE_MS) }); }); await saveMeta(tx, meta); });
    },
    async endWrite(request: EndWriteRequest) {
      assert(validFences(request.fences) && validString(request.token, 128));
      await database.transaction(async tx => { const time = now(), meta = await readMeta(tx); await bump(tx, meta, request.fences, time, fence => { fence.leases = fence.leases.filter(lease => lease.token !== request.token); }); await saveMeta(tx, meta); });
    },
    async invalidate(names: string[]) {
      assert(validFences(names));
      await database.transaction(async tx => { const time = now(), meta = await readMeta(tx); await bump(tx, meta, names, time, () => {}); await saveMeta(tx, meta); });
    },
    async read(request: ReadRequest) {
      assert(validString(request.key, 1024) && validFences(request.fences) && validDuration(request.lockMs) && validGeneration(request.generation));
      return database.transaction(async tx => {
        const time = now(), meta = await readMeta(tx); const changed = await observe(tx, meta, request.generation, time);
        const entry = entryRecord(await tx.get('entry', request.key));
        const lock = lockRecord(await tx.get('lock', request.key));
        const allNames = unique([...request.fences, ...Object.keys(entry?.snapshot ?? {})]);
        const values = await fences(tx, allNames);
        const current = epochs(request.fences, values);
        const liveLock = !!lock && lock.expires > time;
        const held = pending(values, time);
        const acquire = async (kind: Lock['kind']) => {
          if (!lock) { if (meta.locks >= MAX_LOCKS) await sweep(tx, meta, time); if (meta.locks >= MAX_LOCKS) throw new Error('Cache lock capacity exceeded'); meta.locks++; }
          const nextLock: Lock = { token: token(), expires: time + duration(request.lockMs, MAX_LOCK_MS), acquired: time, kind, gc: meta.gc };
          await tx.put('lock', { key: request.key, value: JSON.stringify(nextLock), expiresAt: nextLock.expires }); return nextLock.token;
        };
        if (!held && entry && entry.expires > time && entry.gc === meta.gc && validSnapshot(entry.snapshot) && matches(entry.snapshot, values)) {
          const refreshToken = request.refresh && time >= entry.softExpires && !liveLock && !held ? await acquire('refresh') : null;
          if (changed || refreshToken !== null) await saveMeta(tx, meta);
          return { kind: 'hit' as const, value: entry.value, epochs: current, freshUntil: Math.min(entry.softExpires, entry.expires), refreshToken };
        }
        if (entry) { await tx.delete('entry', request.key); meta.entries--; meta.bytes = Math.max(0, meta.bytes - entry.bytes); }
        const fillHeld = liveLock && lock?.kind !== 'refresh';
        const lockToken = held || fillHeld ? null : await acquire('fill');
        await saveMeta(tx, meta);
        return { kind: 'miss' as const, epochs: current, pending: held, lockToken, lockHeldForMs: fillHeld && lock ? Math.max(0, time - lock.acquired) : null };
      });
    },
    async release(request: ReleaseRequest) {
      assert(validString(request.key, 1024) && validString(request.lockToken, 128));
      await database.transaction(async tx => { const meta = await readMeta(tx), lock = lockRecord(await tx.get('lock', request.key)); if (lock?.token === request.lockToken) { await tx.delete('lock', request.key); meta.locks--; } await saveMeta(tx, meta); });
    },
    async write(request: WriteRequest): Promise<WriteResult> {
      assert(validString(request.key, 1024) && validString(request.lockToken, 128) && typeof request.value === 'string' && validSnapshot(request.snapshot) && validDuration(request.ttlMs) && validDuration(request.softTtlMs));
      return database.transaction(async tx => {
        const time = now(), meta = await readMeta(tx), lock = lockRecord(await tx.get('lock', request.key));
        if (!lock || lock.token !== request.lockToken || lock.expires <= time) return { ok: false, reason: 'lock' };
        await tx.delete('lock', request.key); meta.locks--;
        const values = await fences(tx, Object.keys(request.snapshot));
        if (lock.gc !== meta.gc || pending(values, time) || !matches(request.snapshot, values)) { await saveMeta(tx, meta); return { ok: false, reason: 'fence' }; }
        if (request.ttlMs > MAX_TTL_MS || size(request.value) > MAX_VALUE_BYTES) { await saveMeta(tx, meta); return { ok: false, reason: 'invalid' }; }
        const bytes = size(request.key) + size(request.value) + size(JSON.stringify(request.snapshot));
        const prior = entryRecord(await tx.get('entry', request.key));
        if (prior) { await tx.delete('entry', request.key); meta.entries--; meta.bytes = Math.max(0, meta.bytes - prior.bytes); }
        if (meta.bytes + bytes > options.maxStoredBytes || meta.entries >= MAX_ENTRIES) await sweep(tx, meta, time);
        if (lock.gc !== meta.gc || meta.bytes + bytes > options.maxStoredBytes || meta.entries >= MAX_ENTRIES) { await saveMeta(tx, meta); return { ok: false, reason: lock.gc !== meta.gc ? 'fence' : 'full' }; }
        const entry: Entry = { value: request.value, snapshot: request.snapshot, softExpires: time + Math.min(request.softTtlMs, request.ttlMs), expires: time + request.ttlMs, bytes, gc: meta.gc };
        await tx.put('entry', { key: request.key, value: JSON.stringify(entry), expiresAt: entry.expires }); meta.entries++; meta.bytes += bytes; await saveMeta(tx, meta); return { ok: true };
      });
    },
  };
}
