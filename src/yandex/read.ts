import type { CacheStore } from '../core/types';
import { boundedValue } from '../core/bounded-value';
import { decode, encode, sha256Hex, stableStringify } from '../core/codec';

export async function yandexCacheRead<T>(store: CacheStore, options: { key: unknown; scope: unknown; ttlMs?: number; cacheable?: (value: T) => boolean }, load: () => Promise<T>): Promise<T> {
  const ttl = options.ttlMs ?? 30000;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 300000 || options.scope === null || options.scope === undefined || !boundedValue(options.scope, 32768, true) || !boundedValue(options.key, 32768, true)) return load();
  let identity: string;
  let key: string;
  try { identity = stableStringify([options.scope, options.key]); key = `read:${await sha256Hex(identity)}`; } catch { return load(); }
  let result;
  try { result = await store.read({ key, fences: ['g'], lockMs: 30000, refresh: false }); } catch { return load(); }
  if (result.kind === 'hit') {
    try {
      const envelope: unknown = JSON.parse(result.value);
      if (Array.isArray(envelope) && envelope.length === 2 && envelope[0] === identity) {
        const value = decode(envelope[1]);
        if (boundedValue(value, 1500000, false)) return value as T;
      }
    } catch {}
    return load();
  }
  if (!result.lockToken || result.pending) return load();
  const token = result.lockToken;
  try {
    const value = await load();
    try {
      if (value !== null && value !== undefined && boundedValue(value, 1500000, false) && (options.cacheable?.(value) ?? true)) {
        const text = JSON.stringify([identity, encode(value)]);
        if (new TextEncoder().encode(text).byteLength <= 1500000) await store.write({ key, lockToken: token, snapshot: result.epochs, ttlMs: ttl, softTtlMs: ttl, value: text });
      }
    } catch {}
    return value;
  } finally {
    try { await store.release({ key, lockToken: token }); } catch {}
  }
}
