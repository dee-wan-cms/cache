import type { CacheStore } from "../core/types";
import type { CacheCoordinator } from "./coordinator";

import { retryTransient } from "./retry";
import { type DurableObjectStoreOptions, resolveStoreOptions } from "./store-options";

export function createDurableObjectStore<Env>(
  namespace: DurableObjectNamespace<CacheCoordinator<Env>>,
  options: DurableObjectStoreOptions,
): CacheStore {
  const { attempts, locationHint, name, sleep } = resolveStoreOptions(options);
  const stub = () => namespace.get(namespace.idFromName(name), locationHint ? { locationHint } : undefined);
  const withRetry = <T>(call: (coordinator: ReturnType<typeof stub>) => Promise<T>): Promise<T> =>
    retryTransient(() => call(stub()), attempts, sleep);

  return {
    beginWrite: (request) => withRetry(async (coordinator) => void (await coordinator.beginWrite(request))),
    endWrite: (request) => withRetry(async (coordinator) => void (await coordinator.endWrite(request))),
    invalidate: (fences) => withRetry(async (coordinator) => void (await coordinator.invalidate(fences))),
    read: async (request) => stub().read(request),
    release: async (request) => void (await stub().release(request)),
    write: async (request) => stub().write(request),
  };
}
