import { decode, encode, sha256Hex, stableStringify } from '../core/codec';
import { boundedValue } from './read';
import type { DecimalConstructor } from '../core/types';

const MAX_IDENTITY_BYTES = 32_768;
const MAX_VALUE_BYTES = 1_500_000;

function createRegionalCache(maxMs: number) {
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
      const response = await caches.default.match(key);
      if (!response) return null;
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
          if (size > MAX_VALUE_BYTES) return null;
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
      const now = Date.now();
      if (!Number.isFinite(ttl) || ttl <= 0 || ttl > maxMs || !envelope || typeof envelope !== 'object' || !('started' in envelope) || typeof envelope.started !== 'number' || !Number.isSafeInteger(envelope.started) || envelope.started > now || !('expires' in envelope) || typeof envelope.expires !== 'number' || !Number.isSafeInteger(envelope.expires) || envelope.expires <= now || envelope.expires > envelope.started + ttl || envelope.expires > now + ttl || !('value' in envelope)) return null;
      const value = decode(envelope.value, decimal);
      return value !== null && value !== undefined && boundedValue(value, MAX_VALUE_BYTES, false) && stableStringify(encode(value)) === stableStringify(envelope.value) ? { value, expires: envelope.expires } : null;
    } catch { return null; }
  }

  async function regionalWrite(key: string | null, ttl: number | undefined, started: number, value: unknown): Promise<void> {
    if (!key || !ttl || !Number.isFinite(ttl) || ttl <= 0 || ttl > maxMs || value === null || value === undefined || !boundedValue(value, MAX_VALUE_BYTES, false)) return;
    try {
      const expires = Math.floor(started + ttl);
      if (expires <= Date.now()) return;
      const text = JSON.stringify({ started: Math.floor(started), expires, value: encode(value) });
      if (new TextEncoder().encode(text).byteLength > MAX_VALUE_BYTES) return;
      await caches.default.put(key, new Response(text, { headers: { 'Cache-Control': `public, max-age=${maxMs / 1000}` } }));
    } catch { /* Cache API is optional. */ }
  }

  return { regionalKey, regionalRead, regionalWrite };
}

export const { regionalKey, regionalRead, regionalWrite } = createRegionalCache(5000);
export const { regionalKey: responseLeaseKey, regionalRead: responseLeaseRead, regionalWrite: responseLeaseWrite } = createRegionalCache(30_000);
