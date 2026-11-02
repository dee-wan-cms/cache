import { decode, encode, sha256Hex, stableStringify } from '../core/codec';
import { boundedValue } from '../core/bounded-value';
import type { DecimalConstructor } from '../core/types';

const MAX_IDENTITY_BYTES = 32_768;
export const MAX_VALUE_BYTES = 1_500_000;
export const MAX_RESPONSE_LEASE_BYTES = 8_000_000;

function sameEncodedValue(left: unknown, right: unknown): boolean {
  let remaining = 100_000;
  const same = (a: unknown, b: unknown, depth: number): boolean => {
    if (--remaining < 0 || depth > 64) return false;
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => same(value, b[index], depth + 1));
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && same(Reflect.get(a, key), Reflect.get(b, key), depth + 1));
  };
  return same(left, right, 0);
}

export function createRegionalCache(maxMs: number, maxValueBytes = MAX_VALUE_BYTES, options: { cache?: () => Pick<Cache, 'match' | 'put'>; now?: () => number } = {}) {
  const cache = options.cache ?? (() => caches.default);
  const now = options.now ?? (() => Date.now());
  async function regionalKey(ttl: number | undefined, identity: unknown): Promise<string | null> {
    if (!Number.isFinite(ttl) || !ttl || ttl <= 0 || ttl > maxMs || !boundedValue(identity, MAX_IDENTITY_BYTES, true)) return null;
    try {
      const text = stableStringify(identity);
      if (new TextEncoder().encode(text).byteLength > MAX_IDENTITY_BYTES) return null;
      return `https://dee-wan-cache.invalid/regional-v1/${await sha256Hex(text)}`;
    } catch { return null; }
  }

  async function regionalRead(key: string | null, ttl = maxMs, decimal?: DecimalConstructor): Promise<{ value: unknown; expires: number } | null> {
    if (!key) return null;
    try {
      const response = await cache().match(key);
      if (!response || response.status !== 200 || response.headers.has('set-cookie')) return null;
      const reader = response.body?.getReader();
      if (!reader) return null;
      const chunks: Uint8Array[] = [];
      let size = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('cache body timeout')), 1000); });
        for (;;) {
          const part = await Promise.race([reader.read(), timeout]);
          if (part.done) break;
          size += part.value.byteLength;
          if (size > maxValueBytes) return null;
          chunks.push(part.value);
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        void reader.cancel().catch(() => undefined);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const text = new TextDecoder('utf-8', { fatal:true, ignoreBOM:false }).decode(bytes);
      const envelope: unknown = JSON.parse(text);
      const currentTime = now();
      if (!Number.isFinite(ttl) || ttl <= 0 || ttl > maxMs || !envelope || typeof envelope !== 'object' || !('started' in envelope) || typeof envelope.started !== 'number' || !Number.isSafeInteger(envelope.started) || envelope.started > currentTime || !('expires' in envelope) || typeof envelope.expires !== 'number' || !Number.isSafeInteger(envelope.expires) || envelope.expires <= currentTime || envelope.expires > envelope.started + ttl || envelope.expires > currentTime + ttl || !('value' in envelope)) return null;
      const value = decode(envelope.value, decimal);
      return value !== null && value !== undefined && boundedValue(value, maxValueBytes, false) && sameEncodedValue(encode(value), envelope.value) ? { value, expires: envelope.expires } : null;
    } catch { return null; }
  }

  async function regionalWrite(key: string | null, ttl: number | undefined, started: number, value: unknown): Promise<void> {
    if (!key || !ttl || !Number.isFinite(ttl) || ttl <= 0 || ttl > maxMs || !Number.isSafeInteger(started) || !Number.isSafeInteger(Math.floor(started + ttl)) || value === null || value === undefined || !boundedValue(value, maxValueBytes, false)) return;
    try {
      const expires = Math.floor(started + ttl);
      if (expires <= now()) return;
      const text = JSON.stringify({ started: Math.floor(started), expires, value: encode(value) });
      if (new TextEncoder().encode(text).byteLength > maxValueBytes) return;
      await cache().put(key, new Response(text, { headers: { 'Cache-Control': `public, max-age=${maxMs / 1000}` } }));
    } catch { /* Cache API is optional. */ }
  }

  return { regionalKey, regionalRead, regionalWrite };
}

export const { regionalKey, regionalRead, regionalWrite } = createRegionalCache(5000);
export const { regionalKey: responseLeaseKey } = createRegionalCache(300_000);
