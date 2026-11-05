import { createCacheExtension } from '../core/extension';
import { boundedValue } from '../core/bounded-value';
import { stableStringify } from '../core/codec';
import type { CacheStore, GeneratedCacheConfig } from '../core/types';

export function withYandexPrismaCache<Client extends object>(client: Client, options: {
  store: CacheStore;
  config: GeneratedCacheConfig;
  scope: unknown;
  readModels: readonly string[];
  inTransaction: () => boolean;
  keyArgs?: (args: unknown) => unknown;
  validateQuery?: (model: string, operation: string, args: unknown) => void;
}): Client {
  if (options.scope === null || options.scope === undefined || !boundedValue(options.scope, 32768, true)) return client;
  let scope: string;
  try { scope = stableStringify(options.scope); } catch { return client; }
  const allowed = new Set(options.readModels);
  const config = { ...options.config, cacheableByModel: Object.fromEntries(Object.entries(options.config.cacheableByModel).map(([model, enabled]) => [model, enabled && allowed.has(model)])) };
  const base = createCacheExtension({ config, store: options.store, scope, ...(options.keyArgs ? { keyArgs: options.keyArgs } : {}) });
  const operation = base.query.$allModels.$allOperations;
  const extension = { ...base, query: { $allModels: { $allOperations(params: Parameters<typeof operation>[0]) {
    if (params.model) options.validateQuery?.(params.model, params.operation, params.args);
    if (options.inTransaction()) return params.query(params.args);
    const internal: unknown = params.__internalParams;
    if (internal && typeof internal === 'object' && 'transaction' in internal && internal.transaction) return params.query(params.args);
    return operation(params);
  } } } };
  const extend: unknown = Reflect.get(client, '$extends', client);
  if (typeof extend !== 'function') throw new TypeError('Prisma client must support $extends');
  const extended: unknown = Reflect.apply(extend, client, [extension]);
  if (!extended || typeof extended !== 'object') throw new TypeError('Prisma extension returned no client');
  return new Proxy(client, { get(target, property) {
    const source = property === '$on' || property === '$transaction' ? target : extended;
    const member: unknown = Reflect.get(source, property, source);
    return typeof member === 'function' ? member.bind(source) : member;
  } });
}
