import { createRegionalCache, MAX_VALUE_BYTES } from './d1/regional';
import { limitRegionalDataUntil } from './d1/regional-deadline';

export interface ScopedReadOptions<T> {
  namespace: string;
  key: unknown;
  validate: (value: unknown) => value is T;
  ttlMs?: number;
  maxTtlMs?: number;
  maxBytes?: number;
  cache?: Pick<Cache, 'match' | 'put'>;
  now?: () => number;
  refresh?: { aheadMs: number; waitUntil: (task: Promise<void>) => void; load: () => Promise<T> };
}

type PendingRefresh = { valid: boolean; put?: Promise<void> };
const defaultPending = new Map<string, PendingRefresh>();
const cachePending = new WeakMap<object, Map<string, PendingRefresh>>();
let pendingCount = 0;

export async function cacheReadValue<T>(options: ScopedReadOptions<T>, load: () => Promise<T>): Promise<T> {
  const { namespace, key, validate, ttlMs = 5000, maxTtlMs = 5000, maxBytes = MAX_VALUE_BYTES, cache, now = () => Date.now() } = options;
  if (!Number.isSafeInteger(maxTtlMs) || maxTtlMs < 1 || maxTtlMs > 300_000 || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > maxTtlMs) return load();
  if (typeof namespace !== 'string' || !namespace.trim() || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_VALUE_BYTES) return load();
  const regional = createRegionalCache(maxTtlMs, maxBytes, { cache: cache ? () => cache : undefined, now });
  const cacheKey = await regional.regionalKey(ttlMs, ['scoped-read-value-v1', namespace, key]);
  const cached = await regional.regionalRead(cacheKey, ttlMs);
  let pending = defaultPending;
  if (cache) {
    const existing = cachePending.get(cache);
    if (existing) pending = existing;
    else { pending = new Map(); cachePending.set(cache, pending); }
  }
  try {
    if (cached && validate(cached.value)) {
      limitRegionalDataUntil(cached.expires);
      const refresh = options.refresh;
      if (cacheKey && refresh && Number.isSafeInteger(refresh.aheadMs) && refresh.aheadMs > 0 && refresh.aheadMs <= ttlMs && cached.expires - now() <= refresh.aheadMs && !pending.has(cacheKey) && pendingCount < 1024) {
        const owner: PendingRefresh = { valid:true };
        pending.set(cacheKey, owner);
        pendingCount++;
        let accepted = false;
        const task = Promise.resolve().then(async () => {
          if (!accepted) return;
          const started = now();
          const value = await refresh.load();
          if (owner.valid && validate(value)) {
            owner.put = regional.regionalWrite(cacheKey, ttlMs, started, value);
            await owner.put;
          }
        }).catch(() => {}).finally(() => {
          if (pending.get(cacheKey) === owner) pending.delete(cacheKey);
          pendingCount--;
        });
        try { refresh.waitUntil(task); accepted = true; } catch { /* A declined task never starts its loader. */ }
      }
      return cached.value;
    }
  } catch { /* Invalid cache values fall through to the source. */ }
  const older = cacheKey ? pending.get(cacheKey) : undefined;
  if (older) older.valid = false;
  const started = now();
  const value = await load();
  try {
    if (validate(value)) {
      if (older?.put) await older.put;
      await regional.regionalWrite(cacheKey, ttlMs, started, value);
    }
  } catch { /* Validation failure must not change the source result. */ }
  return value;
}
