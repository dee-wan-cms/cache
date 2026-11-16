import { describe, expect, it } from "vitest";

import type { CacheStore, GeneratedCacheConfig, ReadResponse } from "../../src/core/types";

import { CacheUnavailableError, createCacheExtension } from "../../src/core/extension";
import { CONFIG_FORMAT, MAX_SHAPE_TTL_SECONDS, PLANNER_VERSION } from "../../src/core/limits";

const config: GeneratedCacheConfig = {
  cacheVersion: "t",
  cacheableByModel: { User: true },
  configFormat: CONFIG_FORMAT,
  hasDecimalFields: false,
  primaryKeyNameByModel: {},
  modelNames: ["User"],
  primaryKeyFieldsByModel: { User: ["id"] },
  relationGraph: {},
};

type Call = [string, unknown];

function recordingStore(overrides: Partial<CacheStore>): { calls: Call[]; store: CacheStore } {
  const calls: Call[] = [];
  const record =
    <T>(name: string, fallback: (request: never) => Promise<T>) =>
    (request: never): Promise<T> => {
      calls.push([name, request]);
      return fallback(request);
    };
  const store: CacheStore = {
    beginWrite: record("beginWrite", overrides.beginWrite ?? (() => Promise.resolve())),
    endWrite: record("endWrite", overrides.endWrite ?? (() => Promise.resolve())),
    invalidate: record("invalidate", overrides.invalidate ?? (() => Promise.resolve())),
    read: record("read", overrides.read ?? (() => Promise.reject(new Error("no read")))),
    release: record("release", overrides.release ?? (() => Promise.resolve())),
    write: record("write", overrides.write ?? (() => Promise.resolve({ ok: true as const }))),
  };
  return { calls, store };
}

function readUser(store: CacheStore, extra: Record<string, unknown> = {}) {
  const errors: string[] = [];
  const extension = createCacheExtension({ config, onError: (_error, context) => errors.push(context), store, ...extra });
  const run = (query: (args: unknown) => Promise<unknown>) =>
    extension.query.$allModels.$allOperations({ args: { where: { id: 1 } }, model: "User", operation: "findUnique", query });
  return { errors, extension, run };
}

const miss: ReadResponse = { epochs: { g: 0 }, kind: "miss", lockHeldForMs: null, lockToken: "lock-1", pending: false };

describe("fill locks are released on every failure path", () => {
  it("releases when the coordinator write call throws", async () => {
    const { calls, store } = recordingStore({ read: () => Promise.resolve(miss), write: () => Promise.reject(new Error("network")) });
    const { errors, run } = readUser(store);
    await expect(run(() => Promise.resolve({ id: 1 }))).resolves.toEqual({ id: 1 });
    expect(calls).toContainEqual(["release", { key: expect.any(String), lockToken: "lock-1" }]);
    expect(errors).toContain("write");
  });

  it("releases the refresh lock when a hit cannot be decoded", async () => {
    const hit: ReadResponse = { epochs: { g: 0 }, kind: "hit", refreshToken: "refresh-1", value: "{not json" };
    const { calls, store } = recordingStore({ read: () => Promise.resolve(hit) });
    const { run } = readUser(store, { waitUntil: () => undefined });
    await expect(run(() => Promise.resolve({ id: 1, from: "db" }))).resolves.toEqual({ from: "db", id: 1 });
    expect(calls).toContainEqual(["release", { key: expect.any(String), lockToken: "refresh-1" }]);
  });

  it("serves the hit when waitUntil throws", async () => {
    const hit: ReadResponse = { epochs: { g: 0 }, kind: "hit", refreshToken: "refresh-2", value: JSON.stringify({ id: 1 }) };
    const { calls, store } = recordingStore({ read: () => Promise.resolve(hit) });
    const { errors, run } = readUser(store, {
      waitUntil: () => {
        throw new Error("no request context");
      },
    });
    await expect(run(() => Promise.resolve({ id: 1 }))).resolves.toEqual({ id: 1 });
    expect(errors).toContain("waitUntil");
    expect(calls).toContainEqual(["release", { key: expect.any(String), lockToken: "refresh-2" }]);
  });

  it("releases a refresh lock nobody can use when there is no waitUntil", async () => {
    const hit: ReadResponse = { epochs: { g: 0 }, kind: "hit", refreshToken: "refresh-3", value: JSON.stringify({ id: 1 }) };
    const { calls, store } = recordingStore({ read: () => Promise.resolve(hit) });
    await readUser(store).run(() => Promise.resolve({ id: 1 }));
    expect(calls).toContainEqual(["release", { key: expect.any(String), lockToken: "refresh-3" }]);
  });
});

describe("write leases", () => {
  it("uses one client token for begin and end, and ends the lease when begin fails", async () => {
    const { calls, store } = recordingStore({ beginWrite: () => Promise.reject(new Error("down")) });
    const extension = createCacheExtension({ config, store });
    let executed = false;
    await expect(
      extension.query.$allModels.$allOperations({
        args: { data: { name: "x" }, where: { id: 1 } },
        model: "User",
        operation: "update",
        query: () => {
          executed = true;
          return Promise.resolve({});
        },
      }),
    ).rejects.toBeInstanceOf(CacheUnavailableError);
    expect(executed).toBe(false);
    const begin = calls.find(([name]) => name === "beginWrite")?.[1];
    const end = calls.find(([name]) => name === "endWrite")?.[1];
    expect(begin).toMatchObject({ token: expect.any(String) });
    const beginToken = begin && typeof begin === "object" && "token" in begin ? begin.token : undefined;
    expect(beginToken).toBeTruthy();
    expect(end).toMatchObject({ token: beginToken });
  });
});

describe("review fixes in the extension", () => {
  const related: GeneratedCacheConfig = {
    ...config,
    cacheableByModel: { Secret: false, User: true },
    modelNames: ["User", "Secret"],
    primaryKeyFieldsByModel: { Secret: ["id"], User: ["id"] },
    relationGraph: { User: [{ fieldName: "secrets", foreignFields: [], isList: true, localFields: [], oneToOne: false, targetModel: "Secret" }] },
  };

  const call = (
    extension: ReturnType<typeof createCacheExtension>,
    args: unknown,
    internal: unknown,
    query: (args: unknown) => Promise<unknown> = () => Promise.resolve({ id: 1 }),
  ) =>
    extension.query.$allModels.$allOperations({ __internalParams: internal, args, model: "User", operation: "findUnique", query });

  it("reads straight from the database inside a batch transaction", async () => {
    const { calls, store } = recordingStore({ read: () => Promise.resolve(miss) });
    const extension = createCacheExtension({ config, store });
    await call(extension, { where: { id: 1 } }, { transaction: { id: 1, kind: "batch" } });
    expect(calls.filter(([name]) => name === "read")).toEqual([]);
  });

  it("keys fluent reads apart from direct reads with the same arguments", async () => {
    const { calls, store } = recordingStore({ read: () => Promise.resolve(miss) });
    const extension = createCacheExtension({ config, store });
    const args = { select: { posts: true }, where: { id: 1 } };
    await call(extension, args, { dataPath: [] });
    await call(extension, args, { dataPath: ["select", "posts"] });
    const keys = calls.filter(([name]) => name === "read").map(([, request]) => (request && typeof request === "object" && "key" in request ? request.key : null));
    expect(new Set(keys).size).toBe(2);
  });

  it("does not cache reads that include a model opted out of caching", async () => {
    const { calls, store } = recordingStore({ read: () => Promise.resolve(miss) });
    const extension = createCacheExtension({ config: related, store });
    await call(extension, { include: { secrets: true }, where: { id: 1 } }, {});
    expect(calls.filter(([name]) => name === "read")).toEqual([]);
    await call(extension, { where: { id: 1 } }, {});
    expect(calls.filter(([name]) => name === "read")).toHaveLength(1);
  });

  it("always sends a generation tied to the planner and schema version", async () => {
    const { calls, store } = recordingStore({ read: () => Promise.resolve(miss) });
    await call(createCacheExtension({ config, store }), { where: { id: 1 } }, {});
    await call(createCacheExtension({ config, generation: "ops-7", store }), { where: { id: 1 } }, {});
    const generations = calls.filter(([name]) => name === "read").map(([, request]) => (request && typeof request === "object" && "generation" in request ? request.generation : null));
    expect(generations).toEqual([`${PLANNER_VERSION}/t/`, `${PLANNER_VERSION}/t/ops-7`]);
    await call(createCacheExtension({ config, generation: "ops-7", coordinationGeneration: "1", store }), { where: { id: 1 } }, {});
    const explicit = calls.filter(([name]) => name === "read").at(-1)?.[1];
    expect(explicit).toMatchObject({ generation: "1" });
    await call(createCacheExtension({ config: { ...config, cacheVersion: "next" }, coordinationGeneration: "1", store }), { where: { id: 1 } }, {});
    const reads = calls.filter(([name]) => name === "read").map(([, request]) => request);
    expect(reads.at(-1)).toMatchObject({ generation: "1" });
    expect(reads.at(-1)).not.toMatchObject({ key: (explicit as { key: string }).key });
    expect(() => createCacheExtension({ config, coordinationGeneration: "", store })).toThrow(/coordinationGeneration/);
    expect(() => createCacheExtension({ config, coordinationGeneration: "x".repeat(257), store })).toThrow(/coordinationGeneration/);
  });

  it("waits for a fill and rejects at the configured deadline", async () => {
    const fresh: ReadResponse = { epochs: { g: 0 }, kind: "miss", lockHeldForMs: 5, lockToken: null, pending: false };
    const hit: ReadResponse = { epochs: { g: 0 }, kind: "hit", refreshToken: null, value: JSON.stringify({ id: 1, from: "cache" }) };
    let reads = 0;
    const polling = recordingStore({ read: () => Promise.resolve(++reads === 1 ? fresh : hit) });
    await expect(call(createCacheExtension({ config, store: polling.store }), { where: { id: 1 } }, {})).resolves.toEqual({ from: "cache", id: 1 });
    const held: ReadResponse = { epochs: { g: 0 }, kind: "miss", lockHeldForMs: 25_000, lockToken: null, pending: false };
    const { calls, store } = recordingStore({ read: () => Promise.resolve(held) });
    const extension = createCacheExtension({ config, store, fillWaitMs:5 });
    await expect(call(extension, { where: { id: 1 } }, {}, () => Promise.resolve({ id: 1, from: "db" }))).rejects.toMatchObject({ name:"CacheFillTimeoutError" });
    expect(calls.filter(([name]) => name === "read").length).toBeGreaterThan(1);
  });

  it("rejects TTLs long enough to be refused by the coordinator", () => {
    const { store } = recordingStore({});
    expect(() => createCacheExtension({ config, shape: { default: { freshTtlSeconds: MAX_SHAPE_TTL_SECONDS + 1 } }, store })).toThrow(/freshTtlSeconds/);
    expect(() => createCacheExtension({ config, shape: { default: { freshTtlSeconds: MAX_SHAPE_TTL_SECONDS } }, store })).not.toThrow();
  });
});

describe("generated config format", () => {
  it("rejects configs produced by an older generator", () => {
    const { store } = recordingStore({});
    expect(() => createCacheExtension({ config: JSON.parse(JSON.stringify({ ...config, configFormat: 1 })), store })).toThrow(/run prisma generate/);
  });
});

describe("Decimal schemas", () => {
  it("require the decimal constructor so hits never return strings", () => {
    const { store } = recordingStore({});
    expect(() => createCacheExtension({ config: { ...config, hasDecimalFields: true }, store })).toThrow(/decimal is required/);
    class Decimal {
      constructor(readonly value: string) {}
    }
    expect(() => createCacheExtension({ config: { ...config, hasDecimalFields: true }, decimal: Decimal, store })).not.toThrow();
  });
});

it('uses keyArgs only for read identity and bypasses cache on callback errors', async () => {
  const values = new Map<string, string>();
  const { calls, store } = recordingStore({
    read: async ({ key }) => values.has(key)
      ? { kind: 'hit', epochs: { g: 0 }, refreshToken: null, value: values.get(key)! }
      : miss,
    write: async ({ key, value }) => { values.set(key, value); return { ok: true }; },
  });
  const executed: unknown[] = [];
  const extension = createCacheExtension({ config, store, keyArgs: (args) => {
    if (typeof args !== 'object' || args === null || !('where' in args)) throw new Error('bad args');
    const where = args.where;
    if (typeof where !== 'object' || where === null || !('id' in where)) throw new Error('bad where');
    return { where: { id: String(where.id).split(':')[0] } };
  } });
  const run = (args: unknown) => extension.query.$allModels.$allOperations({ model: 'User', operation: 'findUnique', args, query: async (original) => { executed.push(original); return { id: executed.length }; } });
  const first = { where: { id: 'a:1' } };
  expect(await run(first)).toEqual({ id: 1 });
  expect(await run({ where: { id: 'a:2' } })).toEqual({ id: 1 });
  expect(await run({ where: { id: 'b:1' } })).toEqual({ id: 2 });
  expect(await run({ invalid: true })).toEqual({ id: 3 });
  expect(executed).toEqual([first, { where: { id: 'b:1' } }, { invalid: true }]);
  expect(calls.filter(([name]) => name === 'read')).toHaveLength(3);
});

describe('rejected session cache values', () => {
  it('fails boundedly when a legacy store ignores conditional repair', async () => {
    const hit: ReadResponse = { epochs:{ g:0 }, kind:'hit', refreshToken:null, value:JSON.stringify('old') };
    const { store } = recordingStore({ read:() => Promise.resolve(hit) });
    const { run } = readUser(store, { sessionCache:{ key:() => 'session', read:() => null, fill:async (load:() => Promise<unknown>) => ({ value:await load(), cached:null }) } });
    await expect(run(() => Promise.resolve('source'))).rejects.toMatchObject({ name:'CacheFillTimeoutError', status:503 });
  });
});

it('releases a session fill that cannot safely be cached', async () => {
  const { calls, store } = recordingStore({ read:() => Promise.resolve(miss) });
  const { run } = readUser(store, { sessionCache:{ key:() => 'session', read:() => null, fill:async (load:() => Promise<unknown>) => ({ value:await load(), cached:undefined, cacheable:false }) } });
  await expect(run(() => Promise.resolve('source'))).resolves.toBe('source');
  expect(calls.some(([name]) => name === 'write')).toBe(false);
  expect(calls).toContainEqual(['release', { key:expect.any(String), lockToken:'lock-1' }]);
});

it('rechecks the cache after coordinator recovery before fallback source admission', async () => {
  let reads = 0;
  const { store } = recordingStore({ read:async () => {
    if (++reads === 1) throw new Error('temporarily unavailable');
    return { kind:'hit', epochs:{ g:0 }, refreshToken:null, value:JSON.stringify({ id:1 }) };
  } });
  let sources = 0;
  const { run } = readUser(store);
  await expect(run(async () => { sources++; return { id:2 }; })).resolves.toEqual({ id:1 });
  expect(reads).toBe(2);
  expect(sources).toBe(0);
});

it('registers a foreground fill with waitUntil and settles cleanup on rejection', async () => {
  const { calls, store } = recordingStore({ read:() => Promise.resolve(miss) });
  const retained: Promise<unknown>[] = [];
  const { run } = readUser(store, { waitUntil:(task:Promise<unknown>) => retained.push(task) });
  await expect(run(async () => { throw new Error('source failure'); })).rejects.toThrow('source failure');
  expect(retained).toHaveLength(1);
  await expect(retained[0]).resolves.toBeUndefined();
  expect(calls).toContainEqual(['release', { key:expect.any(String), lockToken:'lock-1' }]);
});

it('serializes same-key pending-write source reads without sharing their values', async () => {
  const pending: ReadResponse = { kind:'miss', epochs:{ g:1 }, lockToken:null, lockHeldForMs:null, pending:true };
  const { store } = recordingStore({ read:async () => pending });
  const { run } = readUser(store);
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let active = 0, max = 0, calls = 0;
  const load = async () => {
    active++; calls++; max = Math.max(max, active);
    try { if (calls === 1) { entered(); await held; } return calls; }
    finally { active--; }
  };
  const first = run(load);
  await started;
  const second = run(load);
  release();
  expect(await Promise.all([first, second])).toEqual([1, 2]);
  expect(max).toBe(1);
  expect(calls).toBe(2);
});

it.each([
  ['error', 'pending', 'pending', 'error'],
  ['pending', 'error', 'error', 'pending'],
])('keeps fresh admissions live while coordinator state changes (%s then %s)', async (...states) => {
  const pending: ReadResponse = { kind:'miss', epochs:{ g:1 }, lockToken:null, lockHeldForMs:null, pending:true };
  let reads = 0;
  let release!: () => void;
  const bothStarted = new Promise<void>((resolve) => { release = resolve; });
  const { store } = recordingStore({ read:async () => {
    const index = reads++;
    if (reads === 2) release();
    if (index < 2) await bothStarted;
    if (states[index] === 'error') throw new Error('coordinator unavailable');
    return pending;
  } });
  const { run } = readUser(store, { fillWaitMs:200 });
  let sources = 0, active = 0, max = 0;
  const load = async () => { active++; sources++; max = Math.max(max, active); try { await Promise.resolve(); return sources; } finally { active--; } };
  expect((await Promise.all([run(load), run(load)])).sort()).toEqual([1, 2]);
  expect(sources).toBe(2);
  expect(max).toBe(1);
});
