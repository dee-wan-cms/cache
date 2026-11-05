import type { CacheStore, ReadResponse } from '../core/types';
import { sha256Hex, stableStringify } from '../core/codec';

type Version = readonly [identity: string, version: string];
type Lease = { originalKey: string; key: string; versions: string; expires: number };

export function versionedCacheStore(store: CacheStore, readVersions: () => Promise<readonly Version[]>): CacheStore {
  const leases = new Map<string, Lease>();
  const versions = async () => {
    const result = await readVersions();
    if (!result.length || result.length > 33 || result.some(([identity, version]) => !identity || !version || identity.length > 1024 || version.length > 1024)) throw new Error('Invalid cache database versions');
    return stableStringify(result);
  };
  const remember = (token: string | null, lease: Lease) => {
    if (!token) return true;
    const time = Date.now();
    for (const [key, value] of leases) if (value.expires <= time) leases.delete(key);
    if (leases.size >= 2048 || leases.has(token)) return false;
    leases.set(token, lease);
    return true;
  };
  const miss = (epochs: Record<string, number>): ReadResponse => ({ kind: 'miss', epochs, pending: true, lockToken: null, lockHeldForMs: null });
  return {
    ...store,
    async read(request) {
      const before = await versions();
      const key = `versioned:${await sha256Hex(stableStringify([request.key, before]))}`;
      const result = await store.read({ ...request, key });
      const token = result.kind === 'hit' ? result.refreshToken : result.lockToken;
      const release = async () => { if (token) await store.release({ key, lockToken: token }); };
      if (before !== await versions()) { await release(); return miss(result.epochs); }
      if (result.kind === 'hit') {
        let envelope: unknown;
        try { envelope = JSON.parse(result.value); } catch { await release(); return miss(result.epochs); }
        if (!Array.isArray(envelope) || envelope.length !== 3 || envelope[0] !== request.key || envelope[1] !== before || typeof envelope[2] !== 'string') {
          await release(); return miss(result.epochs);
        }
        if (!remember(token, { originalKey: request.key, key, versions: before, expires: Date.now() + request.lockMs })) { await release(); return miss(result.epochs); }
        return { ...result, value: envelope[2] };
      }
      if (!remember(token, { originalKey: request.key, key, versions: before, expires: Date.now() + request.lockMs })) { await release(); return miss(result.epochs); }
      return result;
    },
    async write(request) {
      const lease = leases.get(request.lockToken);
      leases.delete(request.lockToken);
      if (!lease || lease.originalKey !== request.key || lease.expires <= Date.now()) return { ok: false, reason: 'lock' };
      if (lease.versions !== await versions()) { await store.release({ key: lease.key, lockToken: request.lockToken }); return { ok: false, reason: 'fence' }; }
      return store.write({ ...request, key: lease.key, value: JSON.stringify([request.key, lease.versions, request.value]) });
    },
    async release(request) {
      const lease = leases.get(request.lockToken);
      leases.delete(request.lockToken);
      if (lease && lease.originalKey === request.key) await store.release({ key: lease.key, lockToken: request.lockToken });
    },
  };
}
