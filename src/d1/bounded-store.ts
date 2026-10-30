import type { CacheStore, EndWriteRequest } from '../core/types';
import { withinCoordinatorDeadline } from './deadline';

const boundedStores = new WeakMap<CacheStore, CacheStore>();

export function boundedD1Store(store: CacheStore): CacheStore {
  const existing = boundedStores.get(store);
  if (existing) return existing;
  const failedBegins = new Set<string>();
  const inspectFences = store.inspectFences;
  const endWrite = async (request: EndWriteRequest): Promise<void> => {
    let active = true;
    try {
      await withinCoordinatorDeadline((async () => {
        for (let attempt = 0; ; attempt++) {
          try { await store.endWrite(request); return; }
          catch (error) { if (!active || attempt === 1) throw error; }
        }
      })());
    } finally { active = false; }
  };
  const bounded: CacheStore = {
    ...store,
    ...(inspectFences ? { inspectFences: (request: Parameters<typeof inspectFences>[0]) => withinCoordinatorDeadline(Promise.resolve().then(() => inspectFences.call(store, request))) } : {}),
    async read(request) {
      const pending = Promise.resolve().then(() => store.read(request));
      try { return await withinCoordinatorDeadline(pending); }
      catch (error) {
        void pending.then((result) => {
          const token = result.kind === 'miss' ? result.lockToken : result.refreshToken;
          if (token) return bounded.release({ key: request.key, lockToken: token });
          return undefined;
        }).catch(() => undefined);
        throw error;
      }
    },
    write: (request) => withinCoordinatorDeadline(Promise.resolve().then(() => store.write(request))),
    release: (request) => withinCoordinatorDeadline(Promise.resolve().then(() => store.release(request))),
    async beginWrite(request) {
      const begin = Promise.resolve().then(() => store.beginWrite(request));
      try { await withinCoordinatorDeadline(begin); }
      catch (error) {
        failedBegins.add(request.token);
        void begin.then(
          () => endWrite({ fences: request.fences, token: request.token }),
          () => endWrite({ fences: request.fences, token: request.token }),
        ).catch(() => undefined);
        throw error;
      }
    },
    async endWrite(request) {
      if (failedBegins.delete(request.token)) return;
      await endWrite(request);
    },
    invalidate: (fences) => withinCoordinatorDeadline(Promise.resolve().then(() => store.invalidate(fences))),
  };
  boundedStores.set(store, bounded);
  boundedStores.set(bounded, bounded);
  return bounded;
}
