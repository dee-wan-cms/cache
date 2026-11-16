import type { CacheStore } from "../core/types";
import type { CacheCoordinator } from "./coordinator";

import { retryTransient } from "./retry";
import { type DurableObjectStoreOptions, resolveStoreOptions } from "./store-options";

const identities = new WeakMap<object, Map<string, object>>();

export function createDurableObjectStore<Env>(
  namespace: DurableObjectNamespace<CacheCoordinator<Env>>,
  options: DurableObjectStoreOptions,
): CacheStore {
  const { attempts, locationHint, name, sleep } = resolveStoreOptions(options);
  let names = identities.get(namespace);
  if (!names) { names = new Map(); identities.set(namespace, names); }
  let identity = names.get(name);
  if (!identity) { identity = {}; if (names.size < 1024) names.set(name, identity); }
  const stub = () => namespace.get(namespace.idFromName(name), locationHint ? { locationHint } : undefined);
  const withRetry = <T>(call: (coordinator: ReturnType<typeof stub>) => Promise<T>): Promise<T> =>
    retryTransient(() => call(stub()), attempts, sleep);

  return {
    coordinationIdentity: identity,
    inspectFences: async (request) => stub().inspectFences(request),
    beginWrite: (request) => withRetry(async (coordinator) => void (await coordinator.beginWrite(request))),
    endWrite: (request) => withRetry(async (coordinator) => void (await coordinator.endWrite(request))),
    invalidate: (fences) => withRetry(async (coordinator) => void (await coordinator.invalidate(fences))),
    read: async (request) => stub().read(request),
    release: async (request) => void (await stub().release(request)),
    write: async (request) => stub().write(request),
  };
}
