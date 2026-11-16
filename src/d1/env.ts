import { CacheFillTimeoutError, localFillOwner } from '../core/wait';
import { D1_BOOKMARK_HEADER, serializeD1Bookmarks } from './bookmarks';
import { createDurableObjectStore } from '../cloudflare/store';
import type { CoordinatorLocationHint } from '../cloudflare/store-options';
import type { CacheCoordinator } from '../cloudflare/coordinator';
import { fenceD1Writes } from './adapter';
import { isD1BindingName, type D1CacheProfile } from './profile';
import { createCacheExtension } from '../core/extension';
import type { CacheStore, DecimalConstructor, GeneratedCacheConfig } from '../core/types';
import { sha256Hex, stableStringify } from '../core/codec';
import { boundedValue, dependencyRuntimes, inspect, sameSnapshots } from './read';
import { boundedD1Store } from './bounded-store';
import { regionalKey, regionalRead, regionalWrite } from './regional';
import { limitRegionalDataUntil } from './regional-deadline';
import { readTargets } from '../core/targets';
import { registerD1SessionAlias, d1SessionBookmarkFloor, wrapD1SessionCacheValue, unwrapD1SessionCacheValue, advanceD1SessionBookmarks, trackD1SessionSource, d1SessionResponseBookmarks, runIsolatedD1Session, withD1SessionAnchor } from './session';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hints = new Set(['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'oc', 'afr', 'me']);
const wrapped = new WeakMap<object, WeakMap<D1Database, Map<string, D1Database>>>();
export interface D1CacheRuntime { store: CacheStore; generation: string; databaseId: string; readsEnabled: boolean; readModels: readonly string[]; coordinatorIdentity: object; coordinatorName: string; regionalIdentity?: string }
const runtimes = new WeakMap<object, D1CacheRuntime>();
export const d1CacheRuntime = (database: object): D1CacheRuntime | undefined => runtimes.get(database);
export function createD1CacheRuntime(database: D1Database, options: { store: CacheStore; databaseId: string; generation: string; readsEnabled?: boolean; profile: D1CacheProfile; coordinatorIdentity?: object; coordinatorName?: string; regionalIdentity?: string }): D1Database {
  const { generation, databaseId, profile, readsEnabled = true } = options;
  const store = boundedD1Store(options.store);
  const fenced = fenceD1Writes(database, { store, generation, policy: profile });
  registerD1SessionAlias(fenced, database);
  runtimes.set(fenced, { store, generation, databaseId, readsEnabled, readModels: profile.readModels, coordinatorIdentity: options.coordinatorIdentity ?? options.store, coordinatorName: options.coordinatorName ?? '', regionalIdentity: options.regionalIdentity });
  return fenced;
}

export function cacheD1Env<T extends object>(env: T, profile: D1CacheProfile): T {
  const value = (suffix: string): unknown => Reflect.get(env, `${profile.envPrefix}_${suffix}`);
  const enabled = value('ENABLED');
  if (enabled === undefined || enabled === 'false') return env;
  if (enabled !== 'true') throw new Error(`Invalid ${profile.envPrefix}_ENABLED`);
  const reads = value('READS_ENABLED');
  if (reads !== undefined && reads !== 'true' && reads !== 'false') throw new Error(`Invalid ${profile.envPrefix}_READS_ENABLED`);
  const readsEnabled = reads !== 'false';
  const namespace = value('COORDINATOR');
  const rawIds = value('DATABASE_IDS');
  const generation = value('GENERATION');
  if (!namespace || typeof namespace !== 'object' || typeof Reflect.get(namespace, 'idFromName') !== 'function' || typeof Reflect.get(namespace, 'get') !== 'function' || typeof rawIds !== 'string' || typeof generation !== 'string' || !generation.trim())
    throw new Error(`${profile.envPrefix} requires coordinator, database identities and generation`);
  if (generation.length > 256) throw new Error(`Invalid ${profile.envPrefix}_GENERATION`);
  let ids: unknown;
  try { ids = JSON.parse(rawIds); } catch { throw new Error(`Invalid ${profile.envPrefix}_DATABASE_IDS`); }
  if (!ids || typeof ids !== 'object' || Array.isArray(ids)) throw new Error(`Invalid ${profile.envPrefix}_DATABASE_IDS`);
  const map = Object.entries(ids);
  if (map.some(([key, id]) => !isD1BindingName(key, profile) || typeof id !== 'string' || !uuid.test(id))) throw new Error('Invalid cache database identity');
  const locationHint = value('LOCATION_HINT') ?? 'weur';
  if (typeof locationHint !== 'string' || !hints.has(locationHint)) throw new Error(`Invalid ${profile.envPrefix}_LOCATION_HINT`);
  const identities = new Map(map);
  const scoped = { ...env };
  for (const name of profile.bindingNames) if (!Reflect.has(env, name)) throw new Error(`Cache missing D1 binding: ${name}`);
  for (const [key, database] of Object.entries(env)) {
    if (profile.bindingPrefixes.some((prefix) => key.startsWith(prefix)) && !isD1BindingName(key, profile)) throw new Error(`Invalid cache binding: ${key}`);
    if (!isD1BindingName(key, profile)) continue;
    const id = identities.get(key);
    if (typeof id !== 'string' || !database || typeof database.prepare !== 'function') throw new Error(`Cache missing D1 identity or binding: ${key}`);
    const databaseId = id.toLowerCase();
    const cacheKey = JSON.stringify([databaseId, generation, locationHint, readsEnabled, profile]);
    let databases = wrapped.get(namespace);
    if (!databases) { databases = new WeakMap(); wrapped.set(namespace, databases); }
    let versions = databases.get(database);
    if (!versions) { versions = new Map(); databases.set(database, versions); }
    let cached = versions.get(cacheKey);
    if (!cached) {
      const coordinatorName = `${profile.coordinatorNamePrefix}${databaseId}`;
      const store = createDurableObjectStore(namespace as DurableObjectNamespace<CacheCoordinator>, { name: coordinatorName, locationHint: locationHint as CoordinatorLocationHint });
      cached = createD1CacheRuntime(database, { store, generation, databaseId, readsEnabled, profile, coordinatorIdentity: namespace, coordinatorName, regionalIdentity: (namespace as DurableObjectNamespace<CacheCoordinator>).idFromName(coordinatorName).toString() });
      versions.set(cacheKey, cached);
    }
    Reflect.set(scoped, key, cached);
  }
  return scoped;
}

export function wrapD1Handler<Event, Env extends object, Context, Result>(handler: (event: Event, env: Env, context: Context) => Result, profile: D1CacheProfile): (event: Event, env: Env, context: Context) => Result {
  return (event, env, context) => handler(event, cacheD1Env(env, profile), context);
}

export interface D1PrismaCacheOptions {
  scope: unknown;
  dependencies?: readonly D1Database[];
  keyArgs?: (args: unknown) => unknown;
  validateQuery?: (model: string, operation: string, args: unknown) => void;
  regionalTtlMs?: number;
  regionalModels?: readonly string[];
  waitUntil?: (promise: Promise<unknown>) => void;
}

export function d1PrismaCacheExtension(database: object, config: GeneratedCacheConfig, optionsOrDecimal?: D1PrismaCacheOptions | DecimalConstructor, decimalArg?: DecimalConstructor): ReturnType<typeof createCacheExtension> | undefined {
  const runtime = runtimes.get(database);
  if (!runtime || !runtime.readsEnabled) return undefined;
  const options = typeof optionsOrDecimal === 'function' ? undefined : optionsOrDecimal;
  const decimal = typeof optionsOrDecimal === 'function' ? optionsOrDecimal : decimalArg;
  const allowed = new Set(runtime.readModels);
  const scopedConfig = { ...config, cacheableByModel: Object.fromEntries(Object.entries(config.cacheableByModel).map(([model, enabled]) => [model, enabled && allowed.has(model)])) };
  const common = { config: scopedConfig, store: runtime.store, generation: runtime.generation, coordinationGeneration: runtime.generation, ...(decimal ? { decimal } : {}), ...(options?.keyArgs ? { keyArgs: options.keyArgs } : {}), ...(options?.waitUntil ? { waitUntil: options.waitUntil, backgroundRefresh: (operation: () => Promise<void>) => {
    const bookmarks = d1SessionResponseBookmarks();
    if (!bookmarks) return operation();
    const encoded = serializeD1Bookmarks(bookmarks);
    return runIsolatedD1Session(new Request('https://d1-session.invalid/', { headers:encoded ? { [D1_BOOKMARK_HEADER]:encoded } : {} }), operation);
  } } : {}) };
  const base = createCacheExtension({ ...common, scope: runtime.databaseId });
  const operation = base.query.$allModels.$allOperations;
  if (!options) return { ...base, query: { $allModels: { $allOperations(params: Parameters<typeof operation>[0]) {
    return d1SessionBookmarkFloor() ? params.query(params.args) : operation(params);
  } } } };
  const scopedOptions = options;
  const scopedOperation = async (params: Parameters<typeof operation>[0], fallbackOwner = false, waitDeadline?: number): Promise<unknown> => {
      if (params.model) scopedOptions.validateQuery?.(params.model, params.operation, params.args);
      if (!params.model || !allowed.has(params.model) || !['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy'].includes(params.operation)) return operation(params);
      if (scopedOptions.scope === null || scopedOptions.scope === undefined || !boundedValue(scopedOptions.scope, 32_768, true) || (scopedOptions.dependencies?.length ?? 0) > 32) return params.query(params.args);
      const dependencies = dependencyRuntimes(database, scopedOptions.dependencies ?? []);
      if (!dependencies) return params.query(params.args);
      const internal = params.__internalParams;
      const dataPath = internal && typeof internal === 'object' && Array.isArray(Reflect.get(internal, 'dataPath')) ? Reflect.get(internal, 'dataPath') : [];
      const transaction: unknown = internal && typeof internal === 'object' ? Reflect.get(internal, 'transaction') : undefined;
      const inBatch = !!transaction && typeof transaction === 'object' && Reflect.get(transaction, 'kind') === 'batch';
      let regional: string | null = null;
      let normalizedArgs: unknown;
      let normalized = false;
      try {
        const identities = [runtime, ...dependencies].map((item) => [item.databaseId, item.generation, item.coordinatorName, item.regionalIdentity]);
        const targets = scopedOptions.regionalModels ? readTargets(config.relationGraph, params.model, params.args) : undefined;
        const allowedTargets = !scopedOptions.regionalModels || (!!targets && [...targets.models].every((model) => scopedOptions.regionalModels?.includes(model)));
        if (scopedOptions.regionalTtlMs && scopedOptions.regionalTtlMs > 0 && scopedOptions.regionalTtlMs <= 5000 && !inBatch && allowedTargets && identities.every((item) => item[3])) {
          normalizedArgs = scopedOptions.keyArgs ? scopedOptions.keyArgs(params.args) : params.args;
          normalized = true;
          const configDigest = await sha256Hex(stableStringify(config));
          regional = await regionalKey(scopedOptions.regionalTtlMs, ['prisma', d1SessionBookmarkFloor() ? 'session-v1' : null, scopedOptions.regionalTtlMs, identities, configDigest, scopedOptions.scope, params.model, params.operation, dataPath, normalizedArgs ?? null]);
        }
      } catch { /* Key callbacks use the strict path on failure. */ }
      const hit = await regionalRead(regional, scopedOptions.regionalTtlMs, decimal);
      if (hit) {
        const cached = unwrapD1SessionCacheValue(hit.value, [runtime, ...dependencies].map((item) => item.databaseId));
        if (cached) { if (cached.bookmarks) advanceD1SessionBookmarks(cached.bookmarks); limitRegionalDataUntil(hit.expires); return cached.value; }
      }
      let started = Date.now();
      const snapshot = await inspect(dependencies);
      if (!snapshot) {
        if (inBatch) return params.query(params.args);
        if (fallbackOwner) {
          if (waitDeadline !== undefined && Date.now() >= waitDeadline) throw new CacheFillTimeoutError();
          return params.query(params.args);
        }
        let fallbackKey: string;
        try {
          const args = normalized ? normalizedArgs : scopedOptions.keyArgs ? scopedOptions.keyArgs(params.args) : params.args;
          const identity = stableStringify([runtime.databaseId, runtime.generation, dependencies.map((item) => [item.databaseId, item.generation, item.coordinatorName]), scopedOptions.scope, params.model, params.operation, dataPath, args]);
          if (new TextEncoder().encode(identity).byteLength > 32_768) return params.query(params.args);
          fallbackKey = `dependency-prisma:${await sha256Hex(identity)}`;
        } catch { return params.query(params.args); }
        const deadline = waitDeadline ?? Date.now() + 30_000;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new CacheFillTimeoutError();
        return localFillOwner(runtime.store.coordinationIdentity ?? runtime.store, fallbackKey, remaining, () => scopedOperation(params, true, deadline));
      }
      let scope: string;
      try {
        scope = stableStringify([d1SessionBookmarkFloor() ? 'session-v1' : null, runtime.databaseId, runtime.generation, scopedOptions.scope, snapshot.map(({ runtime: dependency, epoch }) => [dependency.databaseId, dependency.generation, epoch])]);
        if (new TextEncoder().encode(scope).byteLength > 32_768) return params.query(params.args);
      } catch { return params.query(params.args); }
      let verifiedHit = false;
      let hitBookmarks: Record<string, string> | undefined;
      let verifiedWrite = false;
      let queried = false;
      let sourceBookmarks: Record<string, string> | undefined;
      const store: CacheStore = { ...runtime.store, coordinationIdentity: runtime.store.coordinationIdentity ?? runtime.store,
        async write(request) {
          const wrapped = d1SessionBookmarkFloor() ? (sourceBookmarks ? { d1SessionCache:1, bookmarks:sourceBookmarks, value:request.value } : { d1SessionCache:0 }) : request.value;
          if (wrapped && typeof wrapped === 'object' && Reflect.get(wrapped, 'd1SessionCache') === 0) {
            await runtime.store.release({ key: request.key, lockToken: request.lockToken });
            return { ok:false, reason:'invalid' };
          }
          const value = typeof wrapped === 'string' ? wrapped : JSON.stringify(wrapped);
          const result = await runtime.store.write({ ...request, value });
          verifiedWrite = result.ok;
          return result;
        },
        async read(request) {
        const result = await runtime.store.read(request);
        if (result.kind === 'hit' && !sameSnapshots(snapshot, await inspect(dependencies))) return { kind: 'miss', epochs: result.epochs, lockHeldForMs: null, lockToken: null, pending: true };
        if (result.kind === 'hit' && d1SessionBookmarkFloor()) {
          let cached;
          try { cached = unwrapD1SessionCacheValue(JSON.parse(result.value), [runtime, ...dependencies].map((item) => item.databaseId)); } catch { cached = null; }
          if (!cached || typeof cached.value !== 'string') {
            if (result.refreshToken) await runtime.store.release({ key:request.key, lockToken:result.refreshToken });
            const replacement = await runtime.store.read({ ...request, refresh:false, rejectValue:result.value });
            return replacement.kind === 'hit' ? { kind:'miss', epochs:replacement.epochs, lockHeldForMs:null, lockToken:null, pending:false } : replacement;
          }
          hitBookmarks = cached.bookmarks;
          verifiedHit = true;
          return { ...result, value:cached.value };
        }
        if (result.kind === 'hit') verifiedHit = true;
        return result;
      } };
      const remaining = waitDeadline === undefined ? undefined : waitDeadline - Date.now();
      if (remaining !== undefined && remaining <= 0) throw new CacheFillTimeoutError();
      const scoped = createCacheExtension({ ...common, store, scope, ...(remaining === undefined ? {} : { fillWaitMs:remaining }), ...(normalized ? { keyArgs: () => normalizedArgs } : {}) });
      const tracked = await trackD1SessionSource(async () => {
        const value = await scoped.query.$allModels.$allOperations({ ...params, query: async (args) => {
          queried = true;
          started = Date.now();
          const result = await withD1SessionAnchor([database, ...(scopedOptions.dependencies ?? [])], () => params.query(args));
          sourceBookmarks = result.bookmarks;
          return result.value;
        } });
        if (!queried && verifiedHit && hitBookmarks) advanceD1SessionBookmarks(hitBookmarks);
        return value;
      });
      if (regional && ((!queried && verifiedHit) || verifiedWrite) && sameSnapshots(snapshot, await inspect(dependencies))) await regionalWrite(regional, scopedOptions.regionalTtlMs, started, queried && sourceBookmarks ? { d1SessionCache:1, bookmarks:sourceBookmarks, value:tracked.value } : wrapD1SessionCacheValue(tracked.value, tracked.bookmarks));
      return tracked.value;
    };
  return { ...base, query:{ $allModels:{ $allOperations:(params) => scopedOperation(params) } } };
}

export function withD1PrismaCache<Client extends object>(client: Client, database: object, config: GeneratedCacheConfig, optionsOrDecimal?: D1PrismaCacheOptions | DecimalConstructor, decimalArg?: DecimalConstructor): Client {
  const extension = d1PrismaCacheExtension(database, config, optionsOrDecimal, decimalArg);
  if (!extension) return client;
  const extend: unknown = Reflect.get(client, '$extends', client);
  if (typeof extend !== 'function') throw new TypeError('Prisma client must support $extends');
  const extended: unknown = Reflect.apply(extend, client, [extension]);
  if (!extended || typeof extended !== 'object') throw new TypeError('Prisma extension returned no client');
  return new Proxy(client, {
    get(target, property) {
      const source = property === '$on' ? target : extended;
      const member: unknown = Reflect.get(source, property, source);
      return typeof member === 'function' ? member.bind(source) : member;
    },
  });
}
