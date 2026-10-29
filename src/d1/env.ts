import { createDurableObjectStore } from '../cloudflare/store';
import type { CoordinatorLocationHint } from '../cloudflare/store-options';
import type { CacheCoordinator } from '../cloudflare/coordinator';
import { fenceD1Writes } from './adapter';
import { isD1BindingName, type D1CacheProfile } from './profile';
import { createCacheExtension } from '../core/extension';
import type { CacheStore, DecimalConstructor, GeneratedCacheConfig } from '../core/types';
import { stableStringify } from '../core/codec';
import { boundedValue, dependencyRuntimes, inspect, sameSnapshots } from './read';
import { boundedD1Store } from './bounded-store';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hints = new Set(['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'oc', 'afr', 'me']);
const wrapped = new WeakMap<object, WeakMap<D1Database, Map<string, D1Database>>>();
export interface D1CacheRuntime { store: CacheStore; generation: string; databaseId: string; readsEnabled: boolean; readModels: readonly string[]; coordinatorIdentity: object; coordinatorName: string }
const runtimes = new WeakMap<object, D1CacheRuntime>();
export const d1CacheRuntime = (database: object): D1CacheRuntime | undefined => runtimes.get(database);
export function createD1CacheRuntime(database: D1Database, options: { store: CacheStore; databaseId: string; generation: string; readsEnabled?: boolean; profile: D1CacheProfile; coordinatorIdentity?: object; coordinatorName?: string }): D1Database {
  const { generation, databaseId, profile, readsEnabled = true } = options;
  const store = boundedD1Store(options.store);
  const fenced = fenceD1Writes(database, { store, generation, policy: profile });
  runtimes.set(fenced, { store, generation, databaseId, readsEnabled, readModels: profile.readModels, coordinatorIdentity: options.coordinatorIdentity ?? options.store, coordinatorName: options.coordinatorName ?? '' });
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
      cached = createD1CacheRuntime(database, { store, generation, databaseId, readsEnabled, profile, coordinatorIdentity: namespace, coordinatorName });
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
}

export function d1PrismaCacheExtension(database: object, config: GeneratedCacheConfig, optionsOrDecimal?: D1PrismaCacheOptions | DecimalConstructor, decimalArg?: DecimalConstructor): ReturnType<typeof createCacheExtension> | undefined {
  const runtime = runtimes.get(database);
  if (!runtime || !runtime.readsEnabled) return undefined;
  const options = typeof optionsOrDecimal === 'function' ? undefined : optionsOrDecimal;
  const decimal = typeof optionsOrDecimal === 'function' ? optionsOrDecimal : decimalArg;
  const allowed = new Set(runtime.readModels);
  const scopedConfig = { ...config, cacheableByModel: Object.fromEntries(Object.entries(config.cacheableByModel).map(([model, enabled]) => [model, enabled && allowed.has(model)])) };
  const common = { config: scopedConfig, store: runtime.store, generation: runtime.generation, coordinationGeneration: runtime.generation, ...(decimal ? { decimal } : {}) };
  const base = createCacheExtension({ ...common, scope: runtime.databaseId });
  if (!options) return base;
  const operation = base.query.$allModels.$allOperations;
  return {
    ...base,
    query: { $allModels: { async $allOperations(params: Parameters<typeof operation>[0]) {
      if (!params.model || !allowed.has(params.model) || !['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy'].includes(params.operation)) return operation(params);
      if (options.scope === null || options.scope === undefined || !boundedValue(options.scope, 32_768, true) || (options.dependencies?.length ?? 0) > 32) return params.query(params.args);
      const dependencies = dependencyRuntimes(database, options.dependencies ?? []);
      if (!dependencies) return params.query(params.args);
      const snapshot = await inspect(dependencies);
      if (!snapshot) return params.query(params.args);
      let scope: string;
      try {
        scope = stableStringify([runtime.databaseId, runtime.generation, options.scope, snapshot.map(({ runtime: dependency, epoch }) => [dependency.databaseId, dependency.generation, epoch])]);
        if (new TextEncoder().encode(scope).byteLength > 32_768) return params.query(params.args);
      } catch { return params.query(params.args); }
      const store: CacheStore = { ...runtime.store,
        async read(request) {
        const result = await runtime.store.read(request);
        if (result.kind === 'hit' && !sameSnapshots(snapshot, await inspect(dependencies))) return { kind: 'miss', epochs: result.epochs, lockHeldForMs: null, lockToken: null, pending: true };
        return result;
      } };
      const scoped = createCacheExtension({ ...common, store, scope });
      return scoped.query.$allModels.$allOperations(params);
    } } },
  };
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
