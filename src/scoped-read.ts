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
}

export async function cacheReadValue<T>(options: ScopedReadOptions<T>, load: () => Promise<T>): Promise<T> {
  const { namespace, key, validate, ttlMs = 5000, maxTtlMs = 5000, maxBytes = MAX_VALUE_BYTES, cache, now = () => Date.now() } = options;
  if (!Number.isSafeInteger(maxTtlMs) || maxTtlMs < 1 || maxTtlMs > 300_000 || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > maxTtlMs) return load();
  if (typeof namespace !== 'string' || !namespace.trim() || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_VALUE_BYTES) return load();
  const regional = createRegionalCache(maxTtlMs, maxBytes, { cache: cache ? () => cache : undefined, now });
  const cacheKey = await regional.regionalKey(ttlMs, ['scoped-read-value-v1', namespace, key]);
  const cached = await regional.regionalRead(cacheKey, ttlMs);
  try {
    if (cached && validate(cached.value)) { limitRegionalDataUntil(cached.expires); return cached.value; }
  } catch { /* Invalid cache values fall through to the source. */ }
  const started = now();
  const value = await load();
  try {
    if (validate(value)) await regional.regionalWrite(cacheKey, ttlMs, started, value);
  } catch { /* Validation failure must not change the source result. */ }
  return value;
}
