import { createRegionalCache } from "../d1/regional";
import { withinCoordinatorDeadline } from "../d1/deadline";
import { boundedD1Store } from "../d1/bounded-store";
import type {
  CacheStore,
  EndWriteRequest,
  ReadRequest,
  ReadResponse,
} from "../core/types";
import { GLOBAL_FENCE } from "../core/fences";

export interface RegionalStoreOptions {
  namespace: string;
  generation: string;
  ttlMs: number;
  enabled?: boolean;
  cache?: () => Pick<Cache, "match" | "put">;
  now?: () => number;
  waitUntil?: (promise: Promise<unknown>) => void;
}

type Fill = {
  key: string;
  generation: string;
  fences: string[];
  epochs: Record<string, number>;
  revision: number;
  started: number;
  expires: number;
};
type TokenQueue = { tail: Promise<void>; count: number };
type State = {
  revision: number;
  floor: number;
  pending: Set<string>;
  tokenQueues: Map<string, TokenQueue>;
  invalidations: number;
  unsafe: boolean;
  unsafeVersion: number;
  overflow: boolean;
  failedEnds: Map<string, EndWriteRequest>;
  repairing: boolean;
  nextRepairAt: number;
  fills: Map<string, Fill>;
  refreshes: Set<string>;
};
const states = new Map<string, State>();
const MAX_NAMESPACES = 4096;
const MAX_FILLS = 1024;
const MAX_REFRESHES = 1024;
const MAX_FAILED_ENDS = 1024;
const MAX_TOKEN_QUEUES = 1024;
const MAX_TOKEN_OPERATIONS = 1024;
const REPAIR_BATCH = 4;
const REPAIR_BACKOFF_MS = 1000;
const fencesFor = (fences: readonly string[]) => [...new Set(fences)].sort();

function stateFor(identity: string): State | undefined {
  const existing = states.get(identity);
  if (existing) return existing;
  if (states.size >= MAX_NAMESPACES) return undefined;
  const state: State = {
    revision: 0,
    floor: -1,
    pending: new Set(),
    tokenQueues: new Map(),
    invalidations: 0,
    unsafe: false,
    unsafeVersion: 0,
    overflow: false,
    failedEnds: new Map(),
    repairing: false,
    nextRepairAt: 0,
    fills: new Map(),
    refreshes: new Set(),
  };
  states.set(identity, state);
  return state;
}

export function createRegionalStore(
  store: CacheStore,
  options: RegionalStoreOptions,
): CacheStore {
  const { namespace, generation, ttlMs } = options;
  if (
    !namespace ||
    !generation ||
    namespace.length > 8192 ||
    generation.length > 8192 ||
    !Number.isFinite(ttlMs) ||
    ttlMs <= 0 ||
    ttlMs > 5000 ||
    new TextEncoder().encode(JSON.stringify([namespace, generation]))
      .byteLength > 16_384
  )
    return store;
  const state = stateFor(namespace);
  if (!state) return store;
  const now = options.now ?? Date.now;
  const regional = createRegionalCache(5000, undefined, {
    cache: options.cache,
    now,
  });
  const renewalStore = boundedD1Store(store);
  const inspectFences = store.inspectFences?.bind(store);
  const enabled = options.enabled !== false;
  const blocked = () =>
    state.unsafe ||
    state.overflow ||
    state.invalidations > 0 ||
    state.pending.size > 0 ||
    state.tokenQueues.size > 0;
  const markUnsafe = () => {
    state.unsafe = true;
    state.unsafeVersion++;
  };
  const deferRepair = () => {
    const at = now();
    if (!Number.isSafeInteger(at)) {
      markUnsafe();
      state.nextRepairAt = Infinity;
      return;
    }
    state.nextRepairAt = Math.max(state.nextRepairAt, at + REPAIR_BACKOFF_MS);
  };
  const bump = () => {
    state.revision++;
    const at = now();
    if (!Number.isSafeInteger(at)) markUnsafe();
    else state.floor = Math.max(state.floor, at);
  };
  const serializeToken = <T>(
    token: string,
    action: () => Promise<T>,
  ): Promise<T> => {
    let queue = state.tokenQueues.get(token);
    if (
      (!queue && state.tokenQueues.size >= MAX_TOKEN_QUEUES) ||
      (queue && queue.count >= MAX_TOKEN_OPERATIONS)
    ) {
      state.overflow = true;
      bump();
      return Promise.reject(
        new Error("Regional write queue capacity exceeded"),
      );
    }
    if (!queue) {
      queue = { tail: Promise.resolve(), count: 0 };
      state.tokenQueues.set(token, queue);
    }
    const current = queue;
    current.count++;
    const result = current.tail.then(action).finally(() => {
      current.count--;
      if (current.count === 0 && state.tokenQueues.get(token) === current)
        state.tokenQueues.delete(token);
    });
    current.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const keyFor = (key: string, fences: readonly string[]) =>
    regional.regionalKey(ttlMs, [
      "cache-store-v2",
      namespace,
      generation,
      key,
      fencesFor(fences),
    ]);
  const clean = () => {
    for (const [token, fill] of state.fills)
      if (fill.expires <= now()) state.fills.delete(token);
  };
  const sameFences = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length &&
    left.every((value, i) => value === right[i]);
  const remember = (
    token: string | null,
    request: ReadRequest,
    epochs: Record<string, number>,
    revision: number,
    started: number,
  ) => {
    if (
      !enabled ||
      !token ||
      request.generation !== generation ||
      !Number.isFinite(request.lockMs) ||
      request.lockMs <= 0 ||
      !sameFences(fencesFor(request.fences), fencesFor(Object.keys(epochs))) ||
      Object.values(epochs).some(
        (epoch) => !Number.isSafeInteger(epoch) || epoch < 0,
      ) ||
      blocked() ||
      revision !== state.revision
    )
      return;
    clean();
    if (state.fills.size >= MAX_FILLS && !state.fills.has(token)) return;
    state.fills.set(token, {
      key: request.key,
      generation,
      fences: fencesFor(request.fences),
      epochs: Object.fromEntries(Object.entries(epochs)),
      revision,
      started,
      expires: now() + request.lockMs,
    });
  };
  const payload = (
    value: unknown,
  ): {
    value: string;
    epochs: Record<string, number>;
    sourceStarted: number;
  } | null => {
    if (
      !value ||
      typeof value !== "object" ||
      !("value" in value) ||
      typeof value.value !== "string" ||
      !("sourceStarted" in value) ||
      typeof value.sourceStarted !== "number" ||
      !Number.isSafeInteger(value.sourceStarted) ||
      value.sourceStarted < 0 ||
      value.sourceStarted > now() ||
      !("epochs" in value) ||
      !value.epochs ||
      typeof value.epochs !== "object" ||
      Array.isArray(value.epochs)
    )
      return null;
    const epochs: Record<string, number> = {};
    for (const [name, epoch] of Object.entries(value.epochs)) {
      if (
        !Number.isSafeInteger(epoch) ||
        typeof epoch !== "number" ||
        epoch < 0
      )
        return null;
      Object.defineProperty(epochs, name, {
        value: epoch,
        enumerable: true,
        configurable: true,
      });
    }
    return { value: value.value, epochs, sourceStarted: value.sourceStarted };
  };
  const promote = async (
    revision: number,
    key: string,
    fences: readonly string[],
    started: number,
    lifetime: number,
    value: { value: string; epochs: Record<string, number> },
  ) => {
    if (
      !enabled ||
      blocked() ||
      revision !== state.revision ||
      started <= state.floor ||
      lifetime <= 0
    )
      return;
    const regionalKey = await keyFor(key, fences);
    if (blocked() || revision !== state.revision || started <= state.floor)
      return;
    await regional.regionalWrite(
      regionalKey,
      Math.min(ttlMs, lifetime),
      started,
      { ...value, sourceStarted: started },
    );
  };
  const refreshAhead = (
    regionalKey: string,
    request: ReadRequest,
    revision: number,
  ) => {
    if (
      !options.waitUntil ||
      blocked() ||
      revision !== state.revision ||
      state.refreshes.has(regionalKey) ||
      state.refreshes.size >= MAX_REFRESHES
    )
      return;
    const copy = { ...request, fences: [...request.fences], refresh: false };
    state.refreshes.add(regionalKey);
    let cancelled = false;
    const task = Promise.resolve()
      .then(async () => {
        if (cancelled || blocked() || revision !== state.revision) return;
        const started = now();
        const result = await renewalStore.read(copy);
        const token =
          result.kind === "miss" ? result.lockToken : result.refreshToken;
        if (token) {
          try {
            await renewalStore.release({ key: copy.key, lockToken: token });
          } catch {
            /* The coordinator lock expires. */
          }
          return;
        }
        if (
          result.kind !== "hit" ||
          typeof result.freshUntil !== "number" ||
          !Number.isSafeInteger(result.freshUntil) ||
          result.freshUntil <= started ||
          !sameFences(
            fencesFor(copy.fences),
            fencesFor(Object.keys(result.epochs)),
          ) ||
          Object.values(result.epochs).some(
            (epoch) => !Number.isSafeInteger(epoch) || epoch < 0,
          )
        )
          return;
        await promote(
          revision,
          copy.key,
          copy.fences,
          started,
          result.freshUntil - started,
          { value: result.value, epochs: result.epochs },
        );
      })
      .catch(() => undefined)
      .finally(() => {
        state.refreshes.delete(regionalKey);
      });
    try {
      options.waitUntil(task);
    } catch {
      cancelled = true;
    }
  };
  const repair = () => {
    if (
      !options.waitUntil ||
      state.repairing ||
      now() < state.nextRepairAt ||
      (!state.unsafe && state.failedEnds.size === 0)
    )
      return;
    state.repairing = true;
    const failed = [...state.failedEnds.entries()]
      .filter(([token]) => !state.tokenQueues.has(token))
      .slice(0, REPAIR_BATCH);
    const unsafeVersion = state.unsafe ? state.unsafeVersion : null;
    let cancelled = false;
    const task = Promise.resolve()
      .then(async () => {
        if (cancelled) return;
        let failedAttempt = false;
        for (const [token, request] of failed) {
          if (state.failedEnds.get(token) !== request) continue;
          try {
            if (state.tokenQueues.has(token)) continue;
            await withinCoordinatorDeadline(
              serializeToken(token, async () => {
                if (state.failedEnds.get(token) !== request) return;
                await store.endWrite({
                  token: request.token,
                  fences: [...request.fences],
                });
                if (state.failedEnds.get(token) === request) {
                  state.failedEnds.delete(token);
                  state.pending.delete(token);
                  bump();
                }
              }),
            );
          } catch {
            failedAttempt = true;
            if (state.failedEnds.get(token) === request) {
              state.failedEnds.delete(token);
              state.failedEnds.set(token, request);
            }
          }
        }
        if (unsafeVersion !== null) {
          try {
            await withinCoordinatorDeadline(store.invalidate([GLOBAL_FENCE]));
            if (state.unsafeVersion === unsafeVersion) {
              state.unsafe = false;
              bump();
            }
          } catch {
            failedAttempt = true;
          }
        }
        if (failedAttempt) deferRepair();
      })
      .catch(() => {
        deferRepair();
      })
      .finally(() => {
        state.repairing = false;
      });
    try {
      options.waitUntil(task);
    } catch {
      cancelled = true;
      deferRepair();
    }
  };
  return {
    ...(inspectFences ? { inspectFences } : {}),
    beginWrite(request) {
      const attempted = { ...request, fences: [...request.fences] };
      if (state.failedEnds.has(attempted.token)) state.overflow = true;
      return serializeToken(attempted.token, async () => {
        const existed = state.pending.has(attempted.token);
        if (state.failedEnds.has(attempted.token)) state.overflow = true;
        state.pending.add(attempted.token);
        bump();
        try {
          await store.beginWrite(attempted);
        } catch (error) {
          if (!existed) state.pending.delete(attempted.token);
          bump();
          throw error;
        }
      });
    },
    endWrite(request) {
      const attempted = { token: request.token, fences: [...request.fences] };
      return serializeToken(attempted.token, async () => {
        const priorFailure = state.failedEnds.get(attempted.token);
        state.pending.add(attempted.token);
        state.invalidations++;
        bump();
        try {
          await store.endWrite({
            token: attempted.token,
            fences: [...attempted.fences],
          });
          if (
            state.failedEnds.get(attempted.token) === priorFailure &&
            (!priorFailure ||
              sameFences(
                fencesFor(priorFailure.fences),
                fencesFor(attempted.fences),
              ))
          ) {
            state.failedEnds.delete(attempted.token);
            state.pending.delete(attempted.token);
          }
        } catch (error) {
          const previous = state.failedEnds.get(attempted.token);
          if (
            previous &&
            !sameFences(fencesFor(previous.fences), fencesFor(attempted.fences))
          )
            state.overflow = true;
          else if (previous || state.failedEnds.size < MAX_FAILED_ENDS)
            state.failedEnds.set(attempted.token, attempted);
          else state.overflow = true;
          deferRepair();
          throw error;
        } finally {
          state.invalidations--;
          bump();
        }
      });
    },
    async invalidate(fences) {
      state.invalidations++;
      bump();
      try {
        await store.invalidate(fences);
      } catch (error) {
        markUnsafe();
        deferRepair();
        throw error;
      } finally {
        state.invalidations--;
        bump();
      }
    },
    async read(request): Promise<ReadResponse> {
      if (blocked()) repair();
      const started = now();
      const revision = state.revision;
      if (enabled && request.generation === generation && !blocked()) {
        const key = await keyFor(request.key, request.fences);
        const hit = await regional.regionalRead(key, ttlMs);
        const cached = hit && payload(hit.value);
        if (
          hit &&
          cached &&
          revision === state.revision &&
          !blocked() &&
          cached.sourceStarted > state.floor &&
          hit.expires > now() &&
          hit.expires > cached.sourceStarted &&
          hit.expires <= cached.sourceStarted + ttlMs &&
          sameFences(
            fencesFor(request.fences),
            fencesFor(Object.keys(cached.epochs)),
          )
        ) {
          if (key && hit.expires - now() <= ttlMs / 2)
            refreshAhead(key, request, revision);
          return {
            kind: "hit",
            value: cached.value,
            epochs: cached.epochs,
            refreshToken: null,
            freshUntil: hit.expires,
          };
        }
      }
      const result = await store.read(request);
      if (result.kind === "miss")
        remember(
          result.pending ? null : result.lockToken,
          request,
          result.epochs,
          revision,
          started,
        );
      else {
        remember(
          result.refreshToken,
          request,
          result.epochs,
          revision,
          started,
        );
        if (
          request.generation === generation &&
          result.refreshToken === null &&
          typeof result.freshUntil === "number" &&
          Number.isSafeInteger(result.freshUntil) &&
          result.freshUntil > started &&
          sameFences(
            fencesFor(request.fences),
            fencesFor(Object.keys(result.epochs)),
          )
        ) {
          await promote(
            revision,
            request.key,
            request.fences,
            started,
            result.freshUntil - started,
            { value: result.value, epochs: result.epochs },
          );
        }
      }
      return result;
    },
    async release(request) {
      state.fills.delete(request.lockToken);
      await store.release(request);
    },
    async write(request) {
      const started = now();
      clean();
      const fill = state.fills.get(request.lockToken);
      state.fills.delete(request.lockToken);
      const result = await store.write(request);
      if (
        result.ok &&
        fill &&
        fill.key === request.key &&
        fill.generation === generation &&
        fill.expires > started &&
        Object.keys(request.snapshot).length > 0 &&
        Object.entries(request.snapshot).every(
          ([fence, epoch]) =>
            Object.hasOwn(fill.epochs, fence) && fill.epochs[fence] === epoch,
        )
      ) {
        await promote(
          fill.revision,
          request.key,
          fill.fences,
          Math.min(started, fill.started),
          Math.min(ttlMs, request.ttlMs, request.softTtlMs),
          { value: request.value, epochs: fill.epochs },
        );
      }
      return result;
    },
  };
}
