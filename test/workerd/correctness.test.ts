import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { type Rig, type RunResult, startRig, until, type WorkerName } from "./rig";

let rig: Rig;
let coordinator = 0;
let coordinatorName = "";

beforeAll(async () => {
  rig = await startRig();
});

afterAll(async () => {
  await rig?.dispose();
});

beforeEach(async () => {
  await rig.reset();
  coordinatorName = `coordinator-${++coordinator}`;
});

const op = (model: string, name: string, args?: unknown) => ({ args, model, op: name });

const run = (steps: unknown[], extra: Record<string, unknown> = {}, worker?: WorkerName): Promise<RunResult> =>
  rig.run({ coordinatorName, steps, ...extra }, worker);

const values = (result: RunResult): unknown[] =>
  result.results.map((step) => {
    if (step.error) throw new Error(step.error);
    return step.value;
  });

const one = async (step: unknown, extra: Record<string, unknown> = {}, worker?: WorkerName) => {
  const { allowError, ...body } = extra;
  const result = await run([step], body, worker);
  const error = result.results[0]?.error;
  if (error && allowError !== true) throw new Error(`step failed: ${error}`);
  return { result, statements: result.statements, value: result.results[0]?.value };
};

async function expectCached(step: unknown, extra: Record<string, unknown> = {}) {
  const again = await one(step, extra);
  expect(again.statements).toBe(0);
  expect(again.result.errors).toEqual([]);
  return again;
}

const seedUsers = () =>
  run([
    op("user", "create", { data: { email: "ada@example.test", id: 1, name: "Ada" } }),
    op("user", "create", { data: { email: "bob@example.test", id: 2, name: "Bob" } }),
    op("post", "create", { data: { authorId: 1, id: 10, title: "First" } }),
  ]);

const findUser = (id: number, args: Record<string, unknown> = {}) => op("user", "findUnique", { where: { id }, ...args });

describe("read-through cache on workerd", () => {
  it("fills on a miss and serves the next read without touching D1", async () => {
    await seedUsers();
    const first = await one(findUser(1));
    const second = await one(findUser(1));
    expect(first.statements).toBeGreaterThan(0);
    expect(second.statements).toBe(0);
    expect(second.value).toEqual(first.value);
  });

  it("caches a negative lookup and invalidates it when the row is created", async () => {
    await one(op("user", "findUnique", { where: { id: 99 } }));
    expect((await one(op("user", "findUnique", { where: { id: 99 } }))).statements).toBe(0);
    await one(op("user", "create", { data: { email: "new@example.test", id: 99, name: "New" } }));
    expect((await one(op("user", "findUnique", { where: { id: 99 } }))).value).toMatchObject({ name: "New" });
  });
});

describe("invalidation after writes", () => {
  it("never returns the pre-write value later in the same request flow", async () => {
    await seedUsers();
    await one(findUser(1));
    await expectCached(findUser(1));
    const flow = values(
      await run([findUser(1), op("user", "update", { data: { name: "Ada Lovelace" }, where: { id: 1 } }), findUser(1)]),
    );
    expect(flow[2]).toMatchObject({ name: "Ada Lovelace" });
    expect((await one(findUser(1))).value).toMatchObject({ name: "Ada Lovelace" });
  });

  it("keeps unrelated entity entries while invalidating the written one", async () => {
    await seedUsers();
    await run([findUser(1), findUser(2)]);
    await expectCached(findUser(1));
    await expectCached(findUser(2));
    await one(op("user", "update", { data: { name: "Ada 2" }, where: { id: 1 } }));
    expect((await one(findUser(2))).statements).toBe(0);
    expect((await one(findUser(1))).value).toMatchObject({ name: "Ada 2" });
  });

  it("invalidates lists and counts on create", async () => {
    await seedUsers();
    await run([op("user", "findMany", { orderBy: { id: "asc" } }), op("user", "count")]);
    await expectCached(op("user", "findMany", { orderBy: { id: "asc" } }));
    await expectCached(op("user", "count"));
    await one(op("user", "create", { data: { email: "cy@example.test", id: 3, name: "Cy" } }));
    const [list, count] = values(await run([op("user", "findMany", { orderBy: { id: "asc" } }), op("user", "count")]));
    expect(list).toHaveLength(3);
    expect(count).toBe(3);
  });

  it("invalidates reads that include a related model when that model is written", async () => {
    await seedUsers();
    const withPosts = findUser(1, { include: { posts: true } });
    await one(withPosts);
    await expectCached(withPosts);
    await one(op("post", "update", { data: { title: "Edited" }, where: { id: 10 } }));
    expect((await one(withPosts)).value).toMatchObject({ posts: [{ title: "Edited" }] });
    await one(op("post", "create", { data: { authorId: 1, id: 11, title: "Second" } }));
    expect((await one(withPosts)).value).toMatchObject({ posts: [{ id: 10 }, { id: 11 }] });
  });

  it("invalidates relation-filter reads when the filtered model changes", async () => {
    await seedUsers();
    const filter = op("user", "findMany", { where: { posts: { some: { title: "Hot" } } } });
    expect((await one(filter)).value).toEqual([]);
    await expectCached(filter);
    await one(op("post", "update", { data: { title: "Hot" }, where: { id: 10 } }));
    expect((await one(filter)).value).toMatchObject([{ id: 1 }]);
  });

  it("invalidates rows removed by an ON DELETE CASCADE foreign key", async () => {
    await seedUsers();
    const post = op("post", "findUnique", { where: { id: 10 } });
    await one(post);
    expect((await one(post)).statements).toBe(0);
    await one(op("user", "delete", { where: { id: 1 } }));
    expect((await one(post)).value).toBeNull();
  });

  it("invalidates entities touched by nested writes", async () => {
    await seedUsers();
    const post = op("post", "findUnique", { where: { id: 10 } });
    await one(post);
    await expectCached(post);
    await one(op("user", "update", { data: { posts: { update: { data: { title: "Nested" }, where: { id: 10 } } } }, where: { id: 1 } }));
    expect((await one(post)).value).toMatchObject({ title: "Nested" });
  });
});

describe("review fixes on real Prisma", () => {
  it("invalidates self-relation reads when the related row of the same model changes", async () => {
    await seedUsers();
    await one(op("user", "update", { data: { managerId: 1 }, where: { id: 2 } }));
    const withManager = findUser(2, { include: { manager: true } });
    expect((await one(withManager)).value).toMatchObject({ manager: { name: "Ada" } });
    expect((await one(withManager)).statements).toBe(0);
    await one(op("user", "update", { data: { name: "Ada Manager" }, where: { id: 1 } }));
    expect((await one(withManager)).value).toMatchObject({ manager: { name: "Ada Manager" } });
  });

  it("invalidates the previous partner when a one-to-one relation is re-pointed", async () => {
    await seedUsers();
    await run([
      op("profile", "create", { data: { bio: "old", id: 3, userId: 1 } }),
      op("profile", "create", { data: { bio: "new", id: 5 } }),
    ]);
    const oldProfile = op("profile", "findUnique", { where: { id: 3 } });
    expect((await one(oldProfile)).value).toMatchObject({ userId: 1 });
    expect((await one(oldProfile)).statements).toBe(0);
    const connect = await one(op("user", "update", { data: { profile: { connect: { id: 5 } } }, where: { id: 1 } }));
    expect(connect.result.results[0]?.error).toBeUndefined();
    const database = await one(oldProfile, { enabled: false });
    expect((await one(oldProfile)).value).toEqual(database.value);
  });
});

describe("transactions on D1", () => {
  it("leaves cache and data unchanged when D1 rejects an interactive transaction", async () => {
    await seedUsers();
    await one(findUser(1));
    const tx = await one(
      {
        steps: [op("user", "update", { data: { name: "In tx" }, where: { id: 1 } }), findUser(1)],
        transaction: "interactive",
      },
      { allowError: true },
    );
    expect(tx.result.results[0]?.error).toMatch(/does not support/);
    const after = await one(findUser(1));
    expect(after.value).toMatchObject({ name: "Ada" });
    expect(after.statements).toBe(0);
  });

  it("settles a batch transaction whose reads are already cached", async () => {
    await seedUsers();
    await run([findUser(1), findUser(2)]);
    await expectCached(findUser(1));
    await expectCached(findUser(2));
    const tx = await one({ steps: [findUser(1), findUser(2)], transaction: "batch" });
    expect(tx.value).toMatchObject([{ name: "Ada" }, { name: "Bob" }]);
    const mixed = await one({
      steps: [findUser(1), op("user", "update", { data: { name: "Bob 2" }, where: { id: 2 } })],
      transaction: "batch",
    });
    expect(mixed.value).toMatchObject([{ name: "Ada" }, { name: "Bob 2" }]);
  });

  it("invalidates writes made inside a batch transaction", async () => {
    await seedUsers();
    await one(findUser(2));
    const tx = await one({
      steps: [op("user", "update", { data: { name: "In batch" }, where: { id: 2 } }), op("user", "count")],
      transaction: "batch",
    });
    expect(tx.result.results[0]?.error).toBeUndefined();
    expect((await one(findUser(2))).value).toMatchObject({ name: "In batch" });
  });
});

describe("concurrency", () => {
  it("lets one request fill a cold key while concurrent requests wait for it", async () => {
    await seedUsers();
    const query = op("user", "findMany", { include: { posts: true }, orderBy: { id: "asc" } });
    const cold = await one(query, { coordinatorName: `${coordinatorName}-cold` });
    const patient = { fillPollDelaysMs: Array.from({ length: 50 }, () => 100) };
    const herd = Promise.all(Array.from({ length: 8 }, () => one(query, { barrierAfterFill: "herd", ...patient })));
    await until(() => rig.barrierState("herd"), (state) => state === "waiting", "first filler at barrier");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await rig.release("herd");
    const results = await herd;
    const statements = results.reduce((sum, result) => sum + result.statements, 0);
    for (const result of results) expect(result.value).toEqual(cold.value);
    expect(statements).toBe(cold.statements);
  });

  it("rejects a fill whose database read raced a committed write", async () => {
    await seedUsers();
    const reader = one(findUser(1), { barrierAfterFill: "race" });
    await until(() => rig.barrierState("race"), (state) => state === "waiting", "reader at barrier");
    await one(op("user", "update", { data: { name: "After race" }, where: { id: 1 } }));
    await rig.release("race");
    const raced = await reader;
    expect(raced.value).toMatchObject({ name: "Ada" });
    expect(raced.result.errors).toContain("write: cache write rejected: fence");
    expect((await one(findUser(1))).value).toMatchObject({ name: "After race" });
  });

  it("does not serve or cache pre-write state while a write lease is open, even if the end bump is lost", async () => {
    await seedUsers();
    await one(findUser(1));
    const writer = one(op("user", "update", { data: { name: "Leased" }, where: { id: 1 } }), {
      barrierAfterBegin: "lease",
      skipEndWrite: true,
    });
    await until(() => rig.barrierState("lease"), (state) => state === "waiting", "writer at barrier");
    const duringLease = await one(findUser(1));
    expect(duringLease.value).toMatchObject({ name: "Ada" });
    expect(duringLease.statements).toBeGreaterThan(0);
    await rig.release("lease");
    await writer;
    expect((await one(findUser(1))).value).toMatchObject({ name: "Leased" });
  });

  it("invalidates entries filled after a lease expired but before the write committed", async () => {
    await seedUsers();
    const writer = one(op("user", "update", { data: { name: "Slow write" }, where: { id: 1 } }), {
      barrierAfterBegin: "slow",
      leaseMs: 1,
    });
    await until(() => rig.barrierState("slow"), (state) => state === "waiting", "writer at barrier");
    const reader = one(findUser(1), { barrierAfterFill: "late-fill" });
    await until(() => rig.barrierState("late-fill"), (state) => state === "waiting", "reader at barrier");
    await rig.release("slow");
    await writer;
    await rig.release("late-fill");
    expect((await reader).value).toMatchObject({ name: "Ada" });
    expect((await one(findUser(1))).value).toMatchObject({ name: "Slow write" });
  });
});

describe("keys, switches and explicit invalidation", () => {
  it("never shares an entry across caller scopes", async () => {
    await seedUsers();
    expect((await one(findUser(1), { scope: "alice" })).statements).toBeGreaterThan(0);
    expect((await one(findUser(1), { scope: "alice" })).statements).toBe(0);
    expect((await one(findUser(1), { scope: "bob" })).statements).toBeGreaterThan(0);
  });

  it("invalidates after raw D1 writes only through the explicit API", async () => {
    await seedUsers();
    await one(findUser(1));
    await one({ params: ["Raw", 1], raw: "UPDATE User SET name = ? WHERE id = ?" });
    expect((await one(findUser(1))).value).toMatchObject({ name: "Ada" });
    await one({ params: ["Raw 2", 1], raw: "UPDATE User SET name = ? WHERE id = ?", rawTarget: { models: ["User"] } });
    expect((await one(findUser(1))).value).toMatchObject({ name: "Raw 2" });
    await one({ params: ["Raw 3", 1], raw: "UPDATE User SET name = ? WHERE id = ?" });
    await one({ invalidate: { entities: [{ model: "User", pk: [1] }] } });
    expect((await one(findUser(1))).value).toMatchObject({ name: "Raw 3" });
    await one({ params: ["Raw 4", 1], raw: "UPDATE User SET name = ? WHERE id = ?" });
    await one({ invalidate: { all: true } });
    expect((await one(findUser(1))).value).toMatchObject({ name: "Raw 4" });
  });

  it("never caches a model opted out in the schema", async () => {
    await one(op("secret", "create", { data: { id: 1, value: "s" } }));
    await one(op("secret", "findUnique", { where: { id: 1 } }));
    expect((await one(op("secret", "findUnique", { where: { id: 1 } }))).statements).toBeGreaterThan(0);
  });

  it("re-enabling under a new generation never serves entries from before writes made while off", async () => {
    await seedUsers();
    await one(findUser(1), { generation: "v1" });
    await one(op("user", "update", { data: { name: "Written while off" }, where: { id: 1 } }), { enabled: false, generation: "v2" });
    expect((await one(findUser(1), { generation: "v1" })).value).toMatchObject({ name: "Ada" });
    expect((await one(findUser(1), { generation: "v3" })).value).toMatchObject({ name: "Written while off" });
  });

  it("stores nothing while the runtime switch is off", async () => {
    await seedUsers();
    expect((await one(findUser(1), { enabled: false })).statements).toBeGreaterThan(0);
    expect((await one(findUser(1), { enabled: false })).statements).toBeGreaterThan(0);
    expect((await one(findUser(1))).statements).toBeGreaterThan(0);
    expect((await one(findUser(1))).statements).toBe(0);
  });
});

describe("coordinator unavailable", () => {
  it("reads fall through to D1 instead of serving cached state", async () => {
    await seedUsers();
    await one(findUser(1));
    await one({ params: ["Changed", 1], raw: "UPDATE User SET name = ? WHERE id = ?" });
    const read = await one(findUser(1), { coordinator: "broken" });
    expect(read.statements).toBeGreaterThan(0);
    expect(read.value).toMatchObject({ name: "Changed" });
  });

  it("writes are refused before they reach D1", async () => {
    await seedUsers();
    await one(findUser(1));
    const write = await one(op("user", "update", { data: { name: "Unseen" }, where: { id: 1 } }), { allowError: true, coordinator: "broken" });
    expect(write.result.results[0]?.error).toMatch(/CacheUnavailableError/);
    expect(write.statements).toBe(0);
    expect((await one(findUser(1), { coordinator: "broken" })).value).toMatchObject({ name: "Ada" });
    expect((await one(findUser(1))).value).toMatchObject({ name: "Ada" });
  });
});

describe("test Worker access", () => {
  it("refuses requests without the smoke token", async () => {
    expect(await rig.statusWithoutToken()).toBe(403);
  });
});

describe("multiple isolates", () => {
  it("sees invalidation from a write made in another Worker isolate", async () => {
    await seedUsers();
    expect(await rig.isolateId("cache-test-a")).not.toBe(await rig.isolateId("cache-test-b"));
    await one(findUser(1), {}, "cache-test-a");
    expect((await one(findUser(1), {}, "cache-test-b")).statements).toBe(0);
    await one(op("user", "update", { data: { name: "From B" }, where: { id: 1 } }), {}, "cache-test-b");
    expect((await one(findUser(1), {}, "cache-test-a")).value).toMatchObject({ name: "From B" });
  });
});

describe("stale-while-revalidate", () => {
  it("serves a valid entry past its soft TTL and refreshes it through waitUntil", async () => {
    await seedUsers();
    const shape = { freshTtlSeconds: 30, softTtlRatio: 0.01 };
    await one(findUser(1), { shape });
    await one({ params: ["Refreshed", 1], raw: "UPDATE User SET name = ? WHERE id = ?" });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const served = await one(findUser(1), { shape });
    expect(served.value).toMatchObject({ name: "Ada" });
    expect(served.statements).toBe(0);
    const refreshed = await until(
      () => one(findUser(1), { shape }),
      (read) => JSON.stringify(read.value).includes("Refreshed"),
      "refresh",
    );
    expect(refreshed.value).toMatchObject({ name: "Refreshed" });
    expect(refreshed.statements).toBe(0);
  });
});

describe("stored values", () => {
  it("returns Decimal, BigInt, DateTime, Bytes and tag-like Json unchanged from a hit", async () => {
    await one({ seedMeasure: 1 });
    const query = op("measure", "findUnique", { where: { id: 1 } });
    const cold = await one(query);
    const hit = await one(query);
    expect(cold.value).toMatchObject({
      amount: "decimal:10.25",
      at: "date:2026-09-17T01:02:03.004Z",
      big: "bigint:1234567890123",
      blob: "bytes:0,255,7",
      meta: { $t: "d", nested: [{ $t: "o", v: 1 }], v: "not a date" },
    });
    expect(hit.statements).toBe(0);
    expect(hit.value).toEqual(cold.value);
  });

  it("serves values above maxValueBytes from D1 and releases the fill lock", async () => {
    await seedUsers();
    const first = await one(findUser(1), { maxValueBytes: 10 });
    const second = await one(findUser(1), { maxValueBytes: 10 });
    expect(first.statements).toBeGreaterThan(0);
    expect(second.statements).toBeGreaterThan(0);
    expect(second.result.errors).toContain("serialize: cache value exceeds 10 bytes");
    expect(second.value).toMatchObject({ name: "Ada" });
  });

  it("releases the fill lock when the database query throws", async () => {
    const read = op("user", "findUniqueOrThrow", { where: { id: 5 } });
    expect((await one(read, { allowError: true })).result.results[0]?.error).toMatch(/No record was found|NotFound/);
    await one(op("user", "create", { data: { email: "e@example.test", id: 5, name: "Eve" } }));
    const filled = await one(read);
    expect(filled.value).toMatchObject({ name: "Eve" });
    expect(filled.result.errors).toEqual([]);
    expect((await one(read)).statements).toBe(0);
  });
});

describe("Prisma API shapes", () => {
  it("never serves a fluent result to the direct call with the same arguments, or the reverse", async () => {
    await seedUsers();
    const direct = op("user", "findUnique", { select: { posts: { orderBy: { id: "asc" } } }, where: { id: 1 } });
    expect((await one({ fluentPosts: 1 })).value).toMatchObject([{ id: 10 }]);
    expect((await one(direct)).value).toMatchObject({ posts: [{ id: 10 }] });
    expect((await one({ fluentPosts: 1 })).value).toMatchObject([{ id: 10 }]);
    expect((await one(direct)).value).toMatchObject({ posts: [{ id: 10 }] });
  });

  it("invalidates fluent relation reads", async () => {
    await seedUsers();
    const fluent = { fluentPosts: 1 };
    expect((await one(fluent)).value).toMatchObject([{ id: 10 }]);
    expect((await one(fluent)).statements).toBe(0);
    await one(op("post", "create", { data: { authorId: 1, id: 12, title: "Fluent" } }));
    expect((await one(fluent)).value).toMatchObject([{ id: 10 }, { id: 12 }]);
  });

  it("keeps DbNull and JsonNull filters in separate entries", async () => {
    await one({ meta: "DbNull", seedMeasure: 1 });
    await one({ meta: "JsonNull", seedMeasure: 2 });
    expect((await one({ metaIs: "DbNull" })).value).toEqual([{ id: 1 }]);
    const jsonNull = await one({ metaIs: "JsonNull" });
    expect(jsonNull.value).toEqual([{ id: 2 }]);
    expect(jsonNull.statements).toBeGreaterThan(0);
  });
});

describe("extension order", () => {
  it("keys on arguments rewritten by a per-caller extension applied before the cache", async () => {
    await seedUsers();
    const list = op("user", "findMany", { orderBy: { id: "asc" }, select: { name: true } });
    expect((await one(list, { tenantName: "Ada" })).value).toEqual([{ name: "Ada" }]);
    expect((await one(list, { tenantName: "Ada" })).statements).toBe(0);
    expect((await one(list, { tenantName: "Bob" })).value).toEqual([{ name: "Bob" }]);
  });

  it("runs extensions applied before the cache on every read, and skips extensions applied after it on a hit", async () => {
    await seedUsers();
    const before = await one(findUser(1), { innerProbe: "inside" });
    const beforeHit = await one(findUser(1), { innerProbe: "inside" });
    expect(before.result.inner).toBe(1);
    expect(beforeHit.statements).toBe(0);
    expect(beforeHit.result.inner).toBe(1);
    const afterHit = await one(findUser(1), { innerProbe: "outside" });
    expect(afterHit.statements).toBe(0);
    expect(afterHit.result.inner).toBe(0);
    expect((await one(findUser(2), { innerProbe: "outside" })).result.inner).toBe(1);
    expect((await one(findUser(2), { innerProbe: "outside" })).result.inner).toBe(0);
  });
});
