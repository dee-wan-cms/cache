import { boundedValue } from '../core/bounded-value';
import type { D1Database } from '@cloudflare/workers-types';
import { decode, encode, sha256Hex, stableStringify } from '../core/codec';
import { MAX_VALUE_BYTES } from '../core/limits';
import { d1CacheRuntime, type D1CacheRuntime } from './env';
import { regionalKey, regionalRead, regionalWrite } from './regional';
import { limitRegionalDataUntil } from './regional-deadline';

const FENCES = ['g'];
const DEFAULT_TTL_MS = 30_000;
const MAX_TTL_MS = 300_000;
const MAX_IDENTITY_BYTES = 32_768;
const MAX_VALUE_SIZE = Math.min(1_500_000, MAX_VALUE_BYTES);

export interface D1ReadOptions<T> {
  key: unknown;
  scope: unknown;
  dependencies?: readonly D1Database[];
  ttlMs?: number;
  regionalTtlMs?: number;
  cacheable?: (value: T) => boolean;
}

export { boundedValue } from '../core/bounded-value';

export interface Snapshot { runtime: D1CacheRuntime; epoch: number }
export function sameD1CacheDatabase(left: object, right: object): boolean {
  const a = d1CacheRuntime(left);
  const b = d1CacheRuntime(right);
  return !!a && !!b && a.databaseId === b.databaseId && a.generation === b.generation && a.coordinatorIdentity === b.coordinatorIdentity && a.coordinatorName === b.coordinatorName;
}
export async function d1CacheEpoch(database: object): Promise<string | null> {
  const runtime = d1CacheRuntime(database);
  if (!runtime || !runtime.readsEnabled) return null;
  const snapshot = await inspect([runtime]);
  if (!snapshot?.[0]) return null;
  return stableStringify([runtime.databaseId, runtime.generation, snapshot[0].epoch]);
}
export async function inspect(runtimes: readonly D1CacheRuntime[]): Promise<Snapshot[] | null> {
  if (runtimes.length === 0) return [];
  try {
    const states = await Promise.all(runtimes.map(async (runtime) => {
      if (!runtime.store.inspectFences) return null;
      const state = await runtime.store.inspectFences({ fences: FENCES, generation: runtime.generation });
      const epoch = state.epochs.g;
      if (state.pending !== false || typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 0) return null;
      return { runtime, epoch };
    }));
    return states.some((state) => state === null) ? null : states.filter((state): state is Snapshot => state !== null);
  } catch { return null; }
}

export const sameSnapshots = (a: readonly Snapshot[], b: readonly Snapshot[] | null): boolean =>
  b !== null && a.length === b.length && a.every((item, index) => item.runtime.databaseId === b[index]?.runtime.databaseId && item.runtime.generation === b[index]?.runtime.generation && item.epoch === b[index]?.epoch);

export function dependencyRuntimes(database: object, dependencies: readonly object[]): D1CacheRuntime[] | null {
  if (dependencies.length > 32) return null;
  const primary = d1CacheRuntime(database);
  if (!primary || !primary.readsEnabled) return null;
  const byId = new Map<string, D1CacheRuntime>();
  for (const dependency of dependencies) {
    const runtime = d1CacheRuntime(dependency);
    if (!runtime || !runtime.readsEnabled) return null;
    const prior = runtime.databaseId === primary.databaseId ? primary : byId.get(runtime.databaseId);
    if (prior && (prior.generation !== runtime.generation || prior.coordinatorIdentity !== runtime.coordinatorIdentity || prior.coordinatorName !== runtime.coordinatorName)) return null;
    if (runtime.databaseId === primary.databaseId) continue;
    if (!runtime.store.inspectFences) return null;
    byId.set(runtime.databaseId, prior ?? runtime);
  }
  return [...byId.values()].sort((a, b) => a.databaseId.localeCompare(b.databaseId));
}

export async function cacheD1Read<T>(database: D1Database, options: D1ReadOptions<T>, load: () => Promise<T>): Promise<T> {
  const primary = d1CacheRuntime(database);
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  if (!primary || !primary.readsEnabled || !Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_TTL_MS || options.scope === undefined || options.scope === null || !boundedValue(options.scope, MAX_IDENTITY_BYTES, true) || !boundedValue(options.key, MAX_IDENTITY_BYTES, true)) return load();
  const runtimes = dependencyRuntimes(database, options.dependencies ?? []);
  if (!runtimes) return load();
  const regionalIdentities = [primary, ...runtimes].map((runtime) => [runtime.databaseId, runtime.generation, runtime.coordinatorName, runtime.regionalIdentity]);
  const regional = regionalIdentities.every((identity) => identity[3])
    ? await regionalKey(options.regionalTtlMs, ['d1-read', options.regionalTtlMs, regionalIdentities, options.scope, options.key]) : null;
  const hit = await regionalRead(regional, options.regionalTtlMs);
  if (hit) { limitRegionalDataUntil(hit.expires); return hit.value as T; }
  const started = Date.now();
  const snapshot = await inspect(runtimes);
  if (!snapshot) return load();
  let key: string;
  try {
    const identity = stableStringify(['d1-read-v1', primary.databaseId, primary.generation, options.scope, options.key, snapshot.map(({ runtime, epoch }) => [runtime.databaseId, runtime.generation, epoch])]);
    if (new TextEncoder().encode(identity).byteLength > MAX_IDENTITY_BYTES) return load();
    key = `d1:${await sha256Hex(identity)}`;
  } catch { return load(); }
  let result;
  try { result = await primary.store.read({ key, fences: FENCES, generation: primary.generation, lockMs: 30_000, refresh: false }); }
  catch { return load(); }
  if (result.kind === 'hit') {
    try {
      const value: unknown = decode(JSON.parse(result.value));
      if (boundedValue(value, MAX_VALUE_SIZE, false) && sameSnapshots(snapshot, await inspect(runtimes))) {
        await regionalWrite(regional, options.regionalTtlMs, started, value);
        return value as T;
      }
    } catch { /* Invalid cached values are read from the source. */ }
    return load();
  }
  if (!result.lockToken || result.pending) return load();
  const lockToken = result.lockToken;
  try {
    const value = await load();
    try {
      if (value !== null && value !== undefined && boundedValue(value, MAX_VALUE_SIZE, false) && (options.cacheable?.(value) ?? true)) {
        const text = JSON.stringify(encode(value));
        if (new TextEncoder().encode(text).byteLength <= MAX_VALUE_SIZE && sameSnapshots(snapshot, await inspect(runtimes))) {
          const written = await primary.store.write({ key, lockToken, snapshot: result.epochs, ttlMs: ttl, softTtlMs: ttl, value: text });
          if (regional && written.ok && sameSnapshots(snapshot, await inspect(runtimes))) await regionalWrite(regional, options.regionalTtlMs, started, value);
        }
      }
    } catch { /* The source result remains authoritative when caching fails. */ }
    return value;
  } finally {
    try { await primary.store.release({ key, lockToken }); } catch { /* The lock expires if the coordinator cannot be reached. */ }
  }
}
