import { PrismaD1 } from "@prisma/adapter-d1";

import type { CacheCoordinator, CoordinatorLocationHint } from "../../../dist/cloudflare/index.js";
import type { CacheShape, CacheStore, CacheTestHooks, InvalidationTarget } from "../../../dist/index.js";

import { createDurableObjectStore } from "../../../dist/cloudflare/index.js";
import { createCacheExtension } from "../../../dist/index.js";
import { cacheConfig } from "../generated/cache/cache-config";
import { Prisma, PrismaClient } from "../generated/prisma";

export interface Env {
  COORDINATOR: DurableObjectNamespace<CacheCoordinator>;
  DB: D1Database;
  SMOKE_TOKEN?: string;
}

type Step =
  | { args?: unknown; model: string; op: string }
  | { seedMeasure: number; meta?: "DbNull" | "JsonNull" }
  | { fluentPosts: number }
  | { metaIs: "DbNull" | "JsonNull" }
  | { transaction: "batch" | "interactive"; steps: Array<{ args?: unknown; model: string; op: string }> }
  | { invalidate: InvalidationTarget }
  | { params?: Array<number | string>; raw: string; rawTarget?: InvalidationTarget };

interface RunRequest {
  locationHint?: CoordinatorLocationHint;
  fillPollDelaysMs?: number[];
  barrierAfterBegin?: string;
  barrierAfterFill?: string;
  coordinator?: "broken" | "ok";
  coordinatorName?: string;
  enabled?: boolean;
  generation?: string;
  innerProbe?: "inside" | "outside";
  tenantName?: string;
  leaseMs?: number;
  maxValueBytes?: number;
  scope?: string;
  shape?: CacheShape;
  skipEndWrite?: boolean;
  steps: Step[];
}

let isolateId: string | undefined;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const brokenStore: CacheStore = {
  beginWrite: () => Promise.reject(new Error("coordinator down")),
  endWrite: () => Promise.reject(new Error("coordinator down")),
  invalidate: () => Promise.reject(new Error("coordinator down")),
  read: () => Promise.reject(new Error("coordinator down")),
  release: () => Promise.reject(new Error("coordinator down")),
  write: () => Promise.reject(new Error("coordinator down")),
};

async function waitAtBarrier(db: D1Database, name: string): Promise<void> {
  await db.prepare("INSERT OR REPLACE INTO Barrier (name, state) VALUES (?, 'waiting')").bind(name).run();
  for (let i = 0; i < 1000; i++) {
    const row = await db.prepare("SELECT state FROM Barrier WHERE name = ?").bind(name).first<{ state: string }>();
    if (row?.state === "released") return;
    await sleep(10);
  }
  throw new Error(`barrier ${name} was never released`);
}

function countingDb(db: D1Database, counter: { statements: number }): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          counter.statements++;
          return target.prepare(query);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function runStep(client: object, base: PrismaClient, env: Env, step: Step): Promise<unknown> {
  if ("invalidate" in step) {
    const invalidate: unknown = Reflect.get(client, "$cacheInvalidate");
    if (typeof invalidate !== "function") throw new Error("missing $cacheInvalidate");
    return Reflect.apply(invalidate, client, [step.invalidate]);
  }
  if ("seedMeasure" in step) {
    return base.measure.create({
      data: {
        amount: new Prisma.Decimal("10.25"),
        at: new Date("2026-09-17T01:02:03.004Z"),
        big: 1234567890123n,
        blob: new Uint8Array([0, 255, 7]),
        id: step.seedMeasure,
        meta: step.meta ? Prisma[step.meta] : { $t: "d", nested: [{ $t: "o", v: 1 }], v: "not a date" },
      },
    });
  }
  if ("raw" in step) {
    const statement = () => env.DB.prepare(step.raw).bind(...(step.params ?? [])).run().then(() => null);
    if (!step.rawTarget) return statement();
    const rawWrite: unknown = Reflect.get(client, "$cacheRawWrite");
    if (typeof rawWrite !== "function") throw new Error("missing $cacheRawWrite");
    return Reflect.apply(rawWrite, client, [step.rawTarget, statement]);
  }
  if ("fluentPosts" in step) {
    const users: unknown = Reflect.get(client, "user");
    const findUnique: unknown = users && typeof users === "object" ? Reflect.get(users, "findUnique") : undefined;
    if (typeof findUnique !== "function") throw new Error("missing user.findUnique");
    const pending: unknown = Reflect.apply(findUnique, users, [{ where: { id: step.fluentPosts } }]);
    const posts: unknown = pending && typeof pending === "object" ? Reflect.get(pending, "posts") : undefined;
    if (typeof posts !== "function") throw new Error("missing fluent posts()");
    return Reflect.apply(posts, pending, [{ orderBy: { id: "asc" } }]);
  }
  if ("metaIs" in step) {
    return callOperation(client, { args: { orderBy: { id: "asc" }, select: { id: true }, where: { meta: { equals: Prisma[step.metaIs] } } }, model: "measure", op: "findMany" });
  }
  if ("transaction" in step) {
    const transaction: unknown = Reflect.get(client, "$transaction");
    if (typeof transaction !== "function") throw new Error("missing $transaction");
    const pending: unknown =
      step.transaction === "batch"
        ? Reflect.apply(transaction, client, [step.steps.map((inner) => callOperation(client, inner))])
        : Reflect.apply(transaction, client, [
            async (tx: object) => {
              const out: unknown[] = [];
              for (const inner of step.steps) out.push(await callOperation(tx, inner));
              return out;
            },
          ]);
    return Promise.race([
      pending,
      sleep(8000).then(() => {
        throw new Error("transaction did not settle within 8 s");
      }),
    ]);
  }
  return callOperation(client, step);
}

function callOperation(client: object, step: { args?: unknown; model: string; op: string }): unknown {
  const delegate: unknown = Reflect.get(client, step.model);
  const method: unknown = delegate && typeof delegate === "object" ? Reflect.get(delegate, step.op) : undefined;
  if (typeof method !== "function") throw new Error(`unknown operation ${step.model}.${step.op}`);
  return Reflect.apply(method, delegate, [step.args]);
}

function hooksFor(request: RunRequest, db: D1Database): CacheTestHooks {
  const { barrierAfterBegin, barrierAfterFill, skipEndWrite } = request;
  return {
    ...(barrierAfterBegin ? { afterBeginWrite: () => waitAtBarrier(db, barrierAfterBegin) } : {}),
    ...(barrierAfterFill ? { afterFillQuery: () => waitAtBarrier(db, barrierAfterFill) } : {}),
    ...(skipEndWrite ? { skipEndWrite: () => true } : {}),
  };
}

function describe(value: unknown): unknown {
  if (typeof value === "bigint") return `bigint:${value}`;
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (value instanceof Uint8Array) return `bytes:${Array.from(value).join(",")}`;
  if (Prisma.Decimal.isDecimal(value)) return `decimal:${value.toFixed()}`;
  if (Array.isArray(value)) return value.map(describe);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, describe(inner)]));
  return value;
}

function innerProbe(counter: { inner: number }) {
  return {
    name: "inner-probe",
    query: {
      $allModels: {
        $allOperations({ args, query }: { args: unknown; query: (args: unknown) => Promise<unknown> }) {
          counter.inner++;
          return query(args);
        },
      },
    },
  };
}

function tenantFilter(name: string) {
  return {
    name: "tenant-filter",
    query: {
      user: {
        findMany({ args, query }: { args: { where?: object }; query: (args: unknown) => Promise<unknown> }) {
          return query({ ...args, where: { ...args.where, name } });
        },
      },
    },
  };
}

async function run(request: RunRequest, env: Env, ctx: ExecutionContext): Promise<Response> {
  const counter = { inner: 0, statements: 0 };
  const store =
    request.coordinator === "broken" ? brokenStore : createDurableObjectStore(env.COORDINATOR, {
          name: request.coordinatorName ?? "test",
          ...(request.locationHint ? { locationHint: request.locationHint } : {}),
        });
  const errors: string[] = [];
  const base = new PrismaClient({ adapter: new PrismaD1(countingDb(env.DB, counter)) });
  const tenant = request.tenantName ? base.$extends(tenantFilter(request.tenantName)) : base;
  const inside = request.innerProbe === "inside" ? tenant.$extends(innerProbe(counter)) : tenant;
  const cached = inside.$extends(
    createCacheExtension({
      config: cacheConfig,
      decimal: Prisma.Decimal,
      enabled: request.enabled ?? true,
      ...(request.fillPollDelaysMs ? { fillPollDelaysMs: request.fillPollDelaysMs } : {}),
      ...(request.generation ? { generation: request.generation } : {}),
      ...(request.leaseMs ? { leaseMs: request.leaseMs } : {}),
      ...(request.maxValueBytes ? { maxValueBytes: request.maxValueBytes } : {}),
      onError: (error, context) => errors.push(`${context}: ${error instanceof Error ? error.message : String(error)}`),
      scope: request.scope ?? "",
      ...(request.shape ? { shape: { default: request.shape } } : {}),
      store,
      unsafeTestHooks: hooksFor(request, env.DB),
      waitUntil: (promise) => ctx.waitUntil(promise),
    }),
  );
  const client = request.innerProbe === "outside" ? cached.$extends(innerProbe(counter)) : cached;
  const results: Array<{ error: string } | { value: unknown }> = [];
  const started = Date.now();
  for (const step of request.steps) {
    try {
      results.push({ value: describe(await runStep(client, base, env, step)) });
    } catch (error) {
      results.push({ error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
    }
  }
  const elapsedMs = Date.now() - started;
  return Response.json({ elapsedMs, errors, inner: counter.inner, results, statements: counter.statements }, { headers: { "cache-control": "no-store" } });
}

export async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (env.SMOKE_TOKEN !== undefined && request.headers.get("x-smoke-token") !== env.SMOKE_TOKEN) {
    return new Response("forbidden", { status: 403 });
  }
  const url = new URL(request.url);
  if (url.pathname === "/isolate") {
    isolateId ??= crypto.randomUUID();
    return Response.json({ isolateId });
  }
  if (url.pathname === "/barrier") {
    const name = url.searchParams.get("name") ?? "";
    if (request.method === "POST") {
      await env.DB.prepare("INSERT OR REPLACE INTO Barrier (name, state) VALUES (?, 'released')").bind(name).run();
    }
    const row = await env.DB.prepare("SELECT state FROM Barrier WHERE name = ?").bind(name).first<{ state: string }>();
    return Response.json({ state: row?.state ?? null });
  }
  if (url.pathname === "/run" && request.method === "POST") {
    return run(await request.json<RunRequest>(), env, ctx);
  }
  return new Response("not found", { status: 404 });
}
