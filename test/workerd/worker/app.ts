import { PrismaD1 } from "@prisma/adapter-d1";

import type { CacheCoordinator, CoordinatorLocationHint } from "../../../dist/cloudflare/index.js";
import type { CacheShape, CacheStore, CacheTestHooks, InvalidationTarget } from "../../../dist/index.js";

import { createDurableObjectStore } from "../../../dist/cloudflare/index.js";
import { createCacheExtension } from "../../../dist/index.js";
import { limitReadResponseLeaseUntil, wrapReadResponseLease } from "../../../dist/response-lease.js";
import { createD1CacheRuntime, fenceD1Writes, withD1PrismaCache, wrapD1ReadSessionHandler, prismaD1SessionDatabase, runD1SessionOperation } from "../../../dist/d1/index.js";
import { cacheConfig } from "../generated/cache/cache-config";
import { Prisma, PrismaClient } from "../generated/prisma";

export interface Env {
  COORDINATOR: DurableObjectNamespace<CacheCoordinator>;
  DB: D1Database;
  OTHER: D1Database;
  SMOKE_TOKEN?: string;
}

type Step =
  | { args?: unknown; model: string; op: string }
  | { seedMeasure: number; meta?: "DbNull" | "JsonNull" }
  | { fluentPosts: number }
  | { metaIs: "DbNull" | "JsonNull" }
  | { transaction: "batch" | "interactive"; steps: Array<{ args?: unknown; model: string; op: string }> }
  | { invalidate: InvalidationTarget }
  | { params?: Array<number | string>; raw: string; rawTarget?: InvalidationTarget }
  | { rawDependency: string };

interface RunRequest {
  locationHint?: CoordinatorLocationHint;
  fillPollDelaysMs?: number[];
  barrierAfterBegin?: string;
  barrierAfterFill?: string;
  coordinator?: "broken" | "ok";
  coordinatorName?: string;
  enabled?: boolean;
  generation?: string;
  coordinationGeneration?: string;
  fencedRaw?: boolean;
  rawBarrier?: string;
  dependencyScope?: string;
  primaryOnly?: boolean;
  barrierOnHit?: string;
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
  if ("rawDependency" in step) return env.OTHER.prepare(step.rawDependency).run();
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
  const counter = { inner: 0, statements: 0, cacheReads: 0, inspections: 0 };
  const underlyingStore =
    request.coordinator === "broken" ? brokenStore : createDurableObjectStore(env.COORDINATOR, {
          name: request.coordinatorName ?? "test",
          ...(request.locationHint ? { locationHint: request.locationHint } : {}),
        });
  const store: CacheStore = {
    ...underlyingStore,
    read: async (input) => { counter.cacheReads++; const result = await underlyingStore.read(input); if (request.barrierOnHit && result.kind === 'hit') await waitAtBarrier(env.DB, request.barrierOnHit); return result; },
    inspectFences: async (input) => { counter.inspections++; if (!underlyingStore.inspectFences) throw new Error('inspection unavailable'); return underlyingStore.inspectFences(input); },
  };
  const errors: string[] = [];
  const profile = { envPrefix:'TEST_CACHE', bindingNames:['DB'], bindingPrefixes:[], coordinatorNamePrefix:'test:', coordinatorClass:'CacheCoordinator', readModels:['User'], unfencedWriteTables:[] };
  const primary = request.dependencyScope ? createD1CacheRuntime(countingDb(env.DB, counter), { store, databaseId:'primary', generation:'1', profile }) : countingDb(env.DB, counter);
  const controlStore = createDurableObjectStore(env.COORDINATOR, { name: (request.coordinatorName ?? 'test') + ':control' });
  const rawControlStore: CacheStore = request.rawBarrier ? { ...controlStore, beginWrite: async (input) => { await controlStore.beginWrite(input); await waitAtBarrier(env.DB, request.rawBarrier!); } } : controlStore;
  const control = createD1CacheRuntime(env.OTHER, { store: rawControlStore, databaseId:'control', generation:'1', profile });
  const base = new PrismaClient({ adapter: new PrismaD1(primary) });
  const tenant = request.tenantName ? base.$extends(tenantFilter(request.tenantName)) : base;
  const inside = request.innerProbe === "inside" ? tenant.$extends(innerProbe(counter)) : tenant;
  const cached = request.dependencyScope ? withD1PrismaCache(inside, primary, cacheConfig, { scope:{ actor:request.dependencyScope }, dependencies:request.primaryOnly ? [primary] : [control] }, Prisma.Decimal) : inside.$extends(
    createCacheExtension({
      config: cacheConfig,
      decimal: Prisma.Decimal,
      enabled: request.enabled ?? true,
      ...(request.fillPollDelaysMs ? { fillPollDelaysMs: request.fillPollDelaysMs } : {}),
      ...(request.generation ? { generation: request.generation } : {}),
      ...(request.coordinationGeneration ? { coordinationGeneration: request.coordinationGeneration } : {}),
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
  const rawStore: CacheStore = request.rawBarrier ? {
    ...store,
    beginWrite: async (input) => { await store.beginWrite(input); await waitAtBarrier(env.DB, request.rawBarrier!); },
  } : store;
  const runEnv: Env = { ...env, OTHER: control, ...(request.fencedRaw ? { DB: fenceD1Writes(env.DB, { store: rawStore, generation: request.coordinationGeneration ?? '1', policy: { unfencedWriteTables: [] } }) } : {}) };
  const results: Array<{ error: string } | { value: unknown }> = [];
  const started = Date.now();
  for (const step of request.steps) {
    try {
      results.push({ value: describe(await runStep(client, base, runEnv, step)) });
    } catch (error) {
      results.push({ error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
    }
  }
  const elapsedMs = Date.now() - started;
  return Response.json({ elapsedMs, errors, inner: counter.inner, results, statements: counter.statements, cacheReads: counter.cacheReads, inspections: counter.inspections }, { headers: { "cache-control": "no-store" } });
}

const sessionOptions = { bindingNames:['DB'], bindingPrefixes:['SITE_'], databaseIdsEnv:'SESSION_IDS' };
let sessionClientCount = 0;
let sessionCacheHits = 0;
function createSessionClient(database: D1Database, env: Env, beforeRead?: () => Promise<void>, onAdmission?: (operation: string) => void) {
  const underlying = createDurableObjectStore(env.COORDINATOR, { name:'session-prisma-cache' });
  const store: CacheStore = { ...underlying, async read(input) {
    if (beforeRead) await beforeRead();
    const result = await underlying.read(input);
    if (result.kind === 'hit') sessionCacheHits++;
    return result;
  } };
  const profile = { envPrefix:'SESSION', bindingNames:['DB'], bindingPrefixes:[], coordinatorNamePrefix:'session:', coordinatorClass:'CacheCoordinator', readModels:['User'], unfencedWriteTables:[] };
  const fenced = createD1CacheRuntime(database, { store, databaseId:'00000000-0000-0000-0000-000000000001', generation:'1', profile });
  const base = new PrismaClient({ adapter:new PrismaD1(prismaD1SessionDatabase(fenced)) });
  const admitted = base.$extends({ query:{ $allOperations({ args, query, operation }) { onAdmission?.(operation); return runD1SessionOperation(fenced, async () => query(args)); } } });
  return withD1PrismaCache(admitted, fenced, cacheConfig, { scope:'session-test' }, Prisma.Decimal);
}
const sessionClients = new WeakMap<D1Database, ReturnType<typeof createSessionClient>>();
const sessionHandler = wrapD1ReadSessionHandler(async (request: Request, env: Env & { SITE_alias: D1Database; SESSION_IDS: string }) => {
  let client = sessionClients.get(env.DB);
  if (!client) {
    client = createSessionClient(env.DB, env);
    sessionClients.set(env.DB, client);
    sessionClientCount++;
  }
  const url = new URL(request.url);
  const name = url.searchParams.get('name') ?? '';
  if (request.method === 'POST') await client.user.create({ data:{ email:`${name}@example.test`, name } });
  if (url.searchParams.has('unique')) {
    const scopedClient = client;
    const getUnique = () => scopedClient.user.findUnique({ where:{ email:`${name}@example.test` } });
    const getFirst = () => scopedClient.user.findFirst({ where:{ name } });
    const [unique, first] = url.searchParams.has('sequential')
      ? [await getUnique(), await getFirst()]
      : await Promise.all([getUnique(), getFirst()]);
    return Response.json({ unique, first, clientCount:sessionClientCount, cacheHits:sessionCacheHits });
  }
  const rows = await client.user.findMany({ where:{ name } });
  const batch = url.searchParams.has('batch') ? await client.$transaction([client.user.findMany({ where:{ name } }), client.user.count({ where:{ name } })]) : null;
  const alias = await env.SITE_alias.prepare('SELECT COUNT(*) AS total FROM User WHERE name = ?').bind(name).first();
  return Response.json({ rows, batch, alias, clientCount:sessionClientCount, cacheHits:sessionCacheHits });
}, sessionOptions);

async function sessionPendingWriteRace(env: Env, ctx: ExecutionContext): Promise<Response> {
  let entered!: () => void;
  let release!: () => void;
  let writerStarted!: () => void;
  let fenceReady!: () => void;
  let startWriter!: () => void;
  const readEntered = new Promise<void>((resolve) => { entered = resolve; });
  const proceed = new Promise<void>((resolve) => { release = resolve; });
  const writerEntered = new Promise<void>((resolve) => { writerStarted = resolve; });
  const fenced = new Promise<void>((resolve) => { fenceReady = resolve; });
  const writerGo = new Promise<void>((resolve) => { startWriter = resolve; });
  const ids = JSON.stringify({ DB:'00000000-0000-0000-0000-000000000001' });
  const coordinator = createDurableObjectStore(env.COORDINATOR, { name:'session-prisma-cache' });
  let client: ReturnType<typeof createSessionClient> | undefined;
  let held = false;
  const handler = wrapD1ReadSessionHandler(async (request: Request, scoped: Env & { SESSION_IDS:string }) => {
    client ??= createSessionClient(scoped.DB, scoped, async () => {
      if (held) return;
      held = true;
      entered();
      await proceed;
    }, (operation) => { if (operation === 'create') writerStarted(); });
    if (request.method === 'POST') {
      await client.user.create({ data:{ email:'race-writer@example.test', name:'race-writer' } });
      return Response.json({ written:true });
    }
    const rows = await client.user.findMany({ where:{ name:'race-reader' } });
    return Response.json({ rows });
  }, sessionOptions);
  const scoped = { ...env, SESSION_IDS:ids };
  const write = (async () => {
    await coordinator.beginWrite({ fences:['g'], generation:'1', leaseMs:60_000, token:'session-race' });
    try {
      fenceReady();
      await writerGo;
      return await handler(new Request('https://fixture.test/write', { method:'POST' }), scoped, ctx);
    } finally { await coordinator.endWrite({ fences:['g'], token:'session-race' }); }
  })();
  try {
    await fenced;
    const read = handler(new Request('https://fixture.test/read'), scoped, ctx);
    await readEntered;
    startWriter();
    await writerEntered;
    release();
    const [readResponse, writeResponse] = await Promise.all([read, write]);
    return Response.json({ read:await readResponse.json(), write:await writeResponse.json(), readBookmark:readResponse.headers.get('X-Dee-Wan-D1-Bookmarks'), writeBookmark:writeResponse.headers.get('X-Dee-Wan-D1-Bookmarks') });
  } finally {
    release();
    startWriter();
  }
}

async function sessionWarmWriteRace(env: Env, ctx: ExecutionContext): Promise<Response> {
  let entered!: () => void;
  let release!: () => void;
  let writerStarted!: () => void;
  const warmEntered = new Promise<void>((resolve) => { entered = resolve; });
  const proceed = new Promise<void>((resolve) => { release = resolve; });
  const writerEntered = new Promise<void>((resolve) => { writerStarted = resolve; });
  const ids = JSON.stringify({ DB:'00000000-0000-0000-0000-000000000001' });
  let client: ReturnType<typeof createSessionClient> | undefined;
  let held = false;
  const origin = wrapD1ReadSessionHandler(async (request: Request, scoped: Env & { SESSION_IDS:string }) => {
    const path = new URL(request.url).pathname;
    if (path === '/trigger') { limitReadResponseLeaseUntil(Date.now() + 5000); return Response.json({ ok:true }); }
    client ??= createSessionClient(scoped.DB, scoped, async () => {
      if (held) return;
      held = true;
      entered();
      await proceed;
    }, (operation) => { if (operation === 'create') writerStarted(); });
    if (request.method === 'POST') {
      await client.user.create({ data:{ email:'warm-writer@example.test', name:'warm-writer' } });
      return Response.json({ written:true });
    }
    const rows = await client.user.findMany({ where:{ name:'race-reader' } });
    limitReadResponseLeaseUntil(Date.now() + 5000);
    return Response.json({ rows });
  }, sessionOptions);
  const wrapped = wrapReadResponseLease(origin, {
    namespace:'session-warm-race', deployment:'test', database:'db', seconds:5,
    paths:['/trigger', '/warm-a', '/warm-b'], credentialHeaders:['cookie'], varyHeaders:['x-site-id'], freshnessCookie:'fresh',
    warmup:{ scopeHeader:'x-site-id', seeds:['/warm-a', '/warm-b'], maxTargets:3, concurrency:2, maxMilliseconds:10_000 },
  });
  const gateway = wrapD1ReadSessionHandler(wrapped, sessionOptions);
  const tasks: Promise<unknown>[] = [];
  const execution = { waitUntil(task: Promise<unknown>) { tasks.push(task); }, passThroughOnException:() => ctx.passThroughOnException(), props:ctx.props };
  const scoped = { ...env, SESSION_IDS:ids };
  const headers = { cookie:'session=actor', 'x-site-id':'site-a' };
  try {
    const trigger = await gateway(new Request('https://fixture.test/trigger', { headers }), scoped, execution);
    await trigger.json();
    const drained = (async () => { while (tasks.length) await Promise.all(tasks.splice(0)); })();
    const warmStarted = await Promise.race([warmEntered.then(() => true), drained.then(() => false)]);
    if (!warmStarted) throw new Error('warmup completed before the Prisma read started');
    const write = gateway(new Request('https://fixture.test/write', { method:'POST', headers }), scoped, execution);
    const writerReachedAdmission = await Promise.race([writerEntered.then(() => true), write.then(() => false)]);
    if (!writerReachedAdmission) throw new Error('writer completed before Prisma admission');
    release();
    const result = await write;
    await drained;
    return Response.json({ status:result.status, body:await result.json(), bookmark:result.headers.get('X-Dee-Wan-D1-Bookmarks') });
  } finally { release(); }
}

type AbortedWarmFixture = {
  entered: boolean;
  settled: Set<number>;
  release: () => void;
  fetch: (request: Request, context: ExecutionContext) => Promise<Response>;
};
let abortedWarmFixture: AbortedWarmFixture | undefined;

function createAbortedWarmFixture(env: Env): AbortedWarmFixture {
  let release!: () => void;
  const proceed = new Promise<void>((resolve) => { release = resolve; });
  const state: AbortedWarmFixture = { entered:false, settled:new Set(), release, fetch:async () => new Response(null, { status:500 }) };
  const scoped = { ...env, SESSION_IDS:JSON.stringify({ DB:'00000000-0000-0000-0000-000000000001' }) };
  let client: ReturnType<typeof createSessionClient> | undefined;
  let held = false;
  const origin = wrapD1ReadSessionHandler(async (request: Request, value: Env & { SESSION_IDS:string }) => {
    const path = new URL(request.url).pathname;
    if (path === '/warm-abort/trigger' || path === '/warm-abort/cancel') {
      limitReadResponseLeaseUntil(Date.now() + 5000);
      return Response.json({ ok:true });
    }
    client ??= createSessionClient(value.DB, value, async () => {
      if (held) return;
      held = true;
      state.entered = true;
      await proceed;
    });
    if (request.method === 'POST') {
      await client.user.create({ data:{ email:'abort-writer@example.test', name:'abort-writer' } });
      return Response.json({ written:true });
    }
    const rows = await client.user.findMany({ where:{ name:'race-reader' } });
    limitReadResponseLeaseUntil(Date.now() + 5000);
    return Response.json({ rows });
  }, sessionOptions);
  const lease = wrapReadResponseLease(origin, {
    namespace:'session-warm-abort', deployment:'test', database:'db', seconds:5,
    paths:['/warm-abort/*'], credentialHeaders:['cookie'], varyHeaders:['x-site-id'], freshnessCookie:'fresh',
    warmup:{ scopeHeader:'x-site-id', seeds:['/warm-abort/read'], maxTargets:2, concurrency:1, maxMilliseconds:10_000 },
  });
  const gateway = wrapD1ReadSessionHandler(lease, sessionOptions);
  let index = 0;
  state.fetch = (request, context) => {
    const execution = {
      waitUntil(task: Promise<unknown>) {
        const position = index++;
        context.waitUntil(task.finally(() => { state.settled.add(position); }));
      },
      passThroughOnException:() => context.passThroughOnException(), props:context.props,
    };
    return gateway(request, scoped, execution);
  };
  return state;
}

export async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (env.SMOKE_TOKEN !== undefined && request.headers.get("x-smoke-token") !== env.SMOKE_TOKEN) {
    return new Response("forbidden", { status: 403 });
  }
  const url = new URL(request.url);
  if (url.pathname === '/warm-abort/status') return Response.json({ entered:abortedWarmFixture?.entered ?? false, batchDone:abortedWarmFixture?.settled.has(1) ?? false });
  if (url.pathname === '/warm-abort/release') { abortedWarmFixture?.release(); return Response.json({ ok:true }); }
  if (url.pathname === '/warm-abort/trigger') abortedWarmFixture = createAbortedWarmFixture(env);
  if (url.pathname.startsWith('/warm-abort/')) {
    if (!abortedWarmFixture) return new Response(null, { status:400 });
    return abortedWarmFixture.fetch(request, ctx);
  }
  if (url.pathname === '/session-pending-write-race') return sessionPendingWriteRace(env, ctx);
  if (url.pathname === '/session-warm-write-race') return sessionWarmWriteRace(env, ctx);
  if (url.pathname === '/session') return sessionHandler(request, { ...env, SITE_alias:env.DB, SESSION_IDS:JSON.stringify({ DB:'00000000-0000-0000-0000-000000000001', SITE_alias:'00000000-0000-0000-0000-000000000001' }) }, ctx);
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
