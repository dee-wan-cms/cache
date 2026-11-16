import { CacheFillTimeoutError, waitForFill, localFillOwner, trackLocalFill } from '../core/wait';
import type { CacheStore } from '../core/types';
import { boundedValue } from '../core/bounded-value';
import { decode, encode, sha256Hex, stableStringify } from '../core/codec';

type YandexReadOptions<T> = { key: unknown; scope: unknown; ttlMs?: number; ttlJitterRatio?: number; cacheable?: (value: T) => boolean };

export function yandexCacheRead<T>(store: CacheStore, options: YandexReadOptions<T>, load: () => Promise<T>): Promise<T> {
  return yandexCacheReadInternal(store, options, load, false);
}

async function yandexCacheReadInternal<T>(store: CacheStore, options: YandexReadOptions<T>, load: () => Promise<T>, fallbackOwner: boolean, waitDeadline?: number, pendingOwner = false): Promise<T> {
  const ceiling = options.ttlMs ?? 30000;
  const jitter = options.ttlJitterRatio ?? 0.1;
  const ttl = Math.max(1, Math.floor(ceiling * (1 - Math.random() * jitter)));
  if (!Number.isFinite(ceiling) || ceiling < 1 || ceiling > 300000 || !Number.isFinite(jitter) || jitter < 0 || jitter > 1 || options.scope === null || options.scope === undefined || !boundedValue(options.scope, 32768, true) || !boundedValue(options.key, 32768, true)) return load();
  let identity: string;
  let key: string;
  try { identity = stableStringify([options.scope, options.key]); key = `read:${await sha256Hex(identity)}`; } catch { return load(); }
  const localIdentity = store.coordinationIdentity ?? store;
  const localKey = JSON.stringify(['', key]);
  const deadline = waitDeadline ?? Date.now() + 30000;
  let result;
  try { result = await waitForFill(store, { key, fences: ['g'], lockMs: 30000, refresh: false }, deadline); } catch (error) { if (error instanceof CacheFillTimeoutError) throw error; const remaining = deadline - Date.now(); if (remaining <= 0) throw new CacheFillTimeoutError(); if (fallbackOwner || pendingOwner) return load(); return localFillOwner(localIdentity, `${localKey}:fresh`, remaining, () => yandexCacheReadInternal(store, options, load, true, deadline)); }
  if (result.kind === 'hit') {
    try {
      const envelope: unknown = JSON.parse(result.value);
      if (Array.isArray(envelope) && envelope.length === 2 && envelope[0] === identity) {
        const value = decode(envelope[1]);
        if (boundedValue(value, 1500000, false)) return value as T;
      }
    } catch { /* Invalid cache entries fall back to the source. */ }
    return load();
  }
  if (result.pending) {
    if (pendingOwner || fallbackOwner) return load();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new CacheFillTimeoutError();
    return localFillOwner(localIdentity, `${localKey}:fresh`, remaining, () => yandexCacheReadInternal(store, options, load, false, deadline, true));
  }
  if (!result.lockToken) return load();
  const token = result.lockToken;
  return trackLocalFill(localIdentity, localKey, 30000, async () => {
  try {
    const value = await load();
    try {
      if (value !== null && value !== undefined && boundedValue(value, 1500000, false) && (options.cacheable?.(value) ?? true)) {
        const text = JSON.stringify([identity, encode(value)]);
        if (new TextEncoder().encode(text).byteLength <= 1500000) await store.write({ key, lockToken: token, snapshot: result.epochs, ttlMs: ttl, softTtlMs: ttl, value: text });
      }
    } catch { /* The source value remains authoritative. */ }
    return value;
  } finally {
    try { await store.release({ key, lockToken: token }); } catch { /* The lock expires. */ }
  }
  });
}
