import type { CacheExtensionOptions, InvalidationTarget, ReadResponse } from "./types";

import { decode, encode, sha256Hex, stableStringify } from "./codec";
import { entityFence, GLOBAL_FENCE, modelFence, writeFence } from "./fences";
import {
  CONFIG_FORMAT,
  MAX_GENERATION_LENGTH,
  MAX_LEASE_MS,
  MAX_LOCK_MS,
  MAX_VALUE_BYTES,
  PLANNER_VERSION,
  TTL_JITTER_RATIO,
} from "./limits";
import { planFences, planWrite, rawWritePlanFences, READ_OPERATIONS, WRITE_OPERATIONS } from "./plan";
import { isPlainRecord, pkFromWhere } from "./pk";
import { resolveShape, validateShapes } from "./shape";
import { readTargets } from "./targets";

export class CacheUnavailableError extends Error {
  constructor(cause: unknown) {
    super("cache coordinator unavailable; the write was not executed", { cause });
    this.name = "CacheUnavailableError";
  }
}

export const DEFAULT_FILL_POLL_DELAYS_MS = [20, 40, 80, 160, 320, 640];
export const DEFAULT_LOCK_MS = 30_000;
export const DEFAULT_LEASE_MS = 60_000;
export const DEFAULT_MAX_VALUE_BYTES = 1_500_000;

type Query = (args: unknown) => Promise<unknown>;

interface OperationParams {
  __internalParams?: unknown;
  args: unknown;
  model?: string;
  operation: string;
  query: Query;
}

interface ReadContext {
  args: unknown;
  entityFences: string[] | null;
  fences: string[];
  key: string;
  model: string;
  operation: string;
  query: Query;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const pickEpochs = (epochs: Record<string, number>, fences: string[]): Record<string, number> =>
  Object.fromEntries(fences.map((fence) => [fence, epochs[fence] ?? 0]));

const isNegative = (value: unknown): boolean => value === null || (Array.isArray(value) && value.length === 0);

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);

function internalParams(params: OperationParams): { dataPath: unknown[]; inBatch: boolean } {
  const internal = isPlainRecord(params.__internalParams) ? params.__internalParams : {};
  const transaction = internal.transaction;
  return {
    dataPath: Array.isArray(internal.dataPath) ? internal.dataPath : [],
    inBatch: isPlainRecord(transaction) && transaction.kind === "batch",
  };
}

function validateOptions(options: CacheExtensionOptions): void {
  if (options.config.configFormat !== CONFIG_FORMAT) {
    throw new TypeError(
      `cache extension: generated config format ${String(options.config.configFormat)} does not match ${CONFIG_FORMAT}; run prisma generate`,
    );
  }
  const inRange = (value: number | undefined, max: number) => value === undefined || (Number.isFinite(value) && value > 0 && value <= max);
  const problems = [
    !inRange(options.lockMs, MAX_LOCK_MS) && `lockMs must be in (0, ${MAX_LOCK_MS}]`,
    !inRange(options.leaseMs, MAX_LEASE_MS) && `leaseMs must be in (0, ${MAX_LEASE_MS}]`,
    !inRange(options.maxValueBytes, MAX_VALUE_BYTES) && `maxValueBytes must be in (0, ${MAX_VALUE_BYTES}]`,
    options.fillPollDelaysMs?.some((delay) => !(Number.isFinite(delay) && delay >= 0)) && "fillPollDelaysMs must be non-negative",
    options.excludeModels?.some((model) => !options.config.modelNames.includes(model)) && "excludeModels names an unknown model",
    options.config.hasDecimalFields &&
      !options.decimal &&
      "decimal is required because the schema has Decimal fields (pass Prisma.Decimal)",
    options.generation !== undefined &&
      !(options.generation.length > 0 && options.generation.length <= MAX_GENERATION_LENGTH) &&
      `generation must be 1..${MAX_GENERATION_LENGTH} characters`,
  ].filter((problem): problem is string => typeof problem === "string");
  if (problems.length > 0) throw new TypeError(`cache extension: ${problems.join("; ")}`);
  validateShapes(options.shape);
}

export function createCacheExtension(options: CacheExtensionOptions) {
  validateOptions(options);
  const { config, store, unsafeTestHooks: hooks } = options;
  const enabled = options.enabled ?? true;
  const excluded = new Set(options.excludeModels ?? []);
  const scope = options.scope ?? "";
  const generation = `${PLANNER_VERSION}/${config.cacheVersion}/${options.generation ?? ""}`;
  const pollDelays = options.fillPollDelaysMs ?? DEFAULT_FILL_POLL_DELAYS_MS;
  const lockMs = options.lockMs ?? DEFAULT_LOCK_MS;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const maxValueBytes = options.maxValueBytes ?? DEFAULT_MAX_VALUE_BYTES;
  const report = (error: unknown, context: string): void => options.onError?.(error, context);

  const isCacheable = (model: string): boolean =>
    enabled && config.cacheableByModel[model] === true && !excluded.has(model);

  function readContext(model: string, operation: string, args: unknown, query: Query, key: string): ReadContext | null {
    const targets = readTargets(config.relationGraph, model, args);
    if (!targets || [...targets.models].some((target) => !isCacheable(target))) return null;
    const rootPk = operation.startsWith("findUnique")
      ? pkFromWhere(
          isPlainRecord(args) ? args.where : undefined,
          config.primaryKeyFieldsByModel[model] ?? ["id"],
          config.primaryKeyNameByModel[model],
        )
      : null;
    const base = [GLOBAL_FENCE, modelFence(model)];
    const entity = rootPk === null ? null : entityFence(model, rootPk);
    const fences = [...base, ...[...targets.models].map(writeFence), ...(entity ? [entity] : [])];
    const entityFences = entity && !targets.relational ? [...base, entity] : null;
    return { args, entityFences, fences, key, model, operation, query };
  }

  const release = (key: string, lockToken: string): Promise<void> =>
    store.release({ key, lockToken }).catch((error) => report(error, "release"));

  function serialize(value: unknown): null | string {
    try {
      const serialized = JSON.stringify(encode(value));
      if (new TextEncoder().encode(serialized).byteLength <= maxValueBytes) return serialized;
      report(new Error(`cache value exceeds ${maxValueBytes} bytes`), "serialize");
    } catch (error) {
      report(error, "serialize");
    }
    return null;
  }

  async function fill(ctx: ReadContext, lockToken: string, epochs: Record<string, number>): Promise<unknown> {
    let value: unknown;
    try {
      value = await ctx.query(ctx.args);
      await hooks?.afterFillQuery?.();
    } catch (error) {
      await release(ctx.key, lockToken);
      throw error;
    }
    const serialized = serialize(value);
    if (serialized === null) {
      await release(ctx.key, lockToken);
      return value;
    }
    const shape = resolveShape(options.shape, ctx.model);
    const baseTtl = ctx.operation !== "count" && isNegative(value) ? shape.negativeTtlSeconds : shape.freshTtlSeconds;
    const ttlMs = Math.round(baseTtl * 1000 * (1 + Math.random() * TTL_JITTER_RATIO));
    const snapshotFences = ctx.entityFences && isPlainRecord(value) ? ctx.entityFences : ctx.fences;
    try {
      const result = await store.write({
        key: ctx.key,
        lockToken,
        snapshot: pickEpochs(epochs, snapshotFences),
        softTtlMs: Math.round(ttlMs * shape.softTtlRatio),
        ttlMs,
        value: serialized,
      });
      if (!result.ok) report(new Error(`cache write rejected: ${result.reason}`), "write");
    } catch (error) {
      report(error, "write");
      await release(ctx.key, lockToken);
    }
    return value;
  }

  async function scheduleRefresh(ctx: ReadContext, response: Extract<ReadResponse, { kind: "hit" }>): Promise<void> {
    const token = response.refreshToken;
    if (!token) return;
    if (!options.waitUntil) return release(ctx.key, token);
    try {
      options.waitUntil(fill(ctx, token, response.epochs).catch((error) => report(error, "refresh")));
    } catch (error) {
      report(error, "waitUntil");
      await release(ctx.key, token);
    }
  }

  async function handleRead(model: string, operation: string, args: unknown, query: Query, dataPath: unknown[]): Promise<unknown> {
    let key: string;
    try {
      const identity = [PLANNER_VERSION, config.cacheVersion, scope, model, operation, dataPath, args ?? null];
      key = `${model}:${await sha256Hex(stableStringify(identity))}`;
    } catch (error) {
      report(error, "key");
      return query(args);
    }
    const ctx = readContext(model, operation, args, query, key);
    if (!ctx) return query(args);
    for (let attempt = 0; ; attempt++) {
      let response: ReadResponse;
      try {
        response = await store.read({ fences: ctx.fences, generation, key, lockMs, refresh: !!options.waitUntil });
      } catch (error) {
        report(error, "read");
        return query(args);
      }
      if (response.kind === "hit") {
        let value: unknown;
        try {
          value = decode(JSON.parse(response.value), options.decimal);
        } catch (error) {
          report(error, "decode");
          if (response.refreshToken) await release(key, response.refreshToken);
          return query(args);
        }
        await scheduleRefresh(ctx, response);
        return value;
      }
      if (response.lockToken) return fill(ctx, response.lockToken, response.epochs);
      const delay = pollDelays[attempt];
      const holderTooSlow = response.lockHeldForMs !== null && response.lockHeldForMs > sum(pollDelays);
      if (response.pending || delay === undefined || holderTooSlow) return query(args);
      await sleep(delay);
    }
  }

  async function withLease<T>(fences: string[], run: () => Promise<T>): Promise<T> {
    const token = crypto.randomUUID();
    try {
      await store.beginWrite({ fences, generation, leaseMs, token });
    } catch (error) {
      report(error, "beginWrite");
      await endWrite(token, fences);
      throw new CacheUnavailableError(error);
    }
    try {
      await hooks?.afterBeginWrite?.();
      return await run();
    } finally {
      if (!hooks?.skipEndWrite?.()) await endWrite(token, fences);
    }
  }

  async function endWrite(token: string, fences: string[]): Promise<void> {
    await store.endWrite({ fences, token }).catch((error) => report(error, "endWrite"));
  }

  const targetFences = (target: InvalidationTarget): string[] => rawWritePlanFences(config, target);

  return {
    client: {
      async $cacheInvalidate(target: InvalidationTarget): Promise<void> {
        await store.invalidate(targetFences(target));
      },
      async $cacheRawWrite<T>(target: InvalidationTarget, run: () => Promise<T>): Promise<T> {
        const fences = targetFences(target);
        return enabled ? withLease(fences, run) : run();
      },
    },
    name: "dee-wan-cache",
    query: {
      $allModels: {
        $allOperations(params: OperationParams): Promise<unknown> {
          const { args, model, operation, query } = params;
          if (!model) return query(args);
          const { dataPath, inBatch } = internalParams(params);
          if (READ_OPERATIONS.has(operation) && isCacheable(model) && !inBatch) {
            return handleRead(model, operation, args, query, dataPath);
          }
          if (WRITE_OPERATIONS.has(operation) && enabled) {
            return withLease(planFences(planWrite(config, model, operation, args)), () => query(args));
          }
          return query(args);
        },
      },
    },
  };
}
