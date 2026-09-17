import { beforeAll, describe, expect, it } from "vitest";

const base = process.env.CACHE_SMOKE_URL;
const token = process.env.CACHE_SMOKE_TOKEN;
if (!base || !token) throw new Error("CACHE_SMOKE_URL and CACHE_SMOKE_TOKEN are required: the deployed smoke has no local fallback");
const headers = { "content-type": "application/json", "x-smoke-token": token };

const runId = Date.now();
const coordinatorName = `smoke-${runId}`;
let nextId = runId % 1_000_000_000;
const freshId = () => ++nextId;

interface RunResult {
  errors: string[];
  results: Array<{ error?: string; value?: unknown }>;
  statements: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(path: string, init?: { body?: string; method?: string }): Promise<string> {
  const response = await fetch(new URL(path, base), { ...init, headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text}`);
  return text;
}

async function run(steps: unknown[], extra: Record<string, unknown> = {}): Promise<RunResult> {
  return JSON.parse(await request("/run", { body: JSON.stringify({ coordinatorName, steps, ...extra }), method: "POST" }));
}

async function one(step: unknown, extra: Record<string, unknown> = {}) {
  const result = await run([step], extra);
  return { result, statements: result.statements, value: result.results[0]?.value };
}

async function waitAtBarrier(name: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (JSON.parse(await request(`/barrier?name=${name}`)).state === "waiting") return;
    await sleep(20);
  }
  throw new Error(`barrier ${name} never reached`);
}

const release = (name: string) => request(`/barrier?name=${name}`, { method: "POST" });

const op = (model: string, name: string, args?: unknown) => ({ args, model, op: name });

async function seedUser(name = "Before"): Promise<number> {
  const id = freshId();
  const created = await one(op("user", "create", { data: { email: `smoke-${id}@example.test`, id, name } }));
  expect(created.result.results[0]?.error).toBeUndefined();
  return id;
}

beforeAll(async () => {
  for (let i = 0; i < 60; i++) {
    const response = await fetch(new URL("/isolate", base), { headers }).catch(() => null);
    if (response?.ok) return;
    await sleep(1000);
  }
  throw new Error("deployed Worker did not answer /isolate within 60 s");
}, 90_000);

describe("deployed Worker with D1 and the coordinator Durable Object", () => {
  it("serves hits and invalidates after a write", async () => {
    const id = await seedUser();
    const find = op("user", "findUnique", { where: { id } });
    await one(find);
    expect((await one(find)).statements).toBe(0);
    await one(op("user", "update", { data: { name: "After" }, where: { id } }));
    expect((await one(find)).value).toMatchObject({ name: "After" });
  });

  it("fills a cold key once under concurrent requests", async () => {
    const id = await seedUser();
    const query = op("user", "findMany", { orderBy: { id: "asc" }, where: { id: { gte: id } } });
    const cold = await one(query, { coordinatorName: `${coordinatorName}-cold` });
    const barrier = `herd-${runId}`;
    const pending = Promise.all(Array.from({ length: 8 }, () => one(query, { barrierAfterFill: barrier })));
    await waitAtBarrier(barrier);
    await sleep(200);
    await release(barrier);
    const herd = await pending;
    for (const result of herd) expect(result.value).toEqual(cold.value);
    expect(herd.reduce((sum, result) => sum + result.statements, 0)).toBe(cold.statements);
  });

  it("rejects a fill that raced a committed write", async () => {
    const id = await seedUser();
    const find = op("user", "findUnique", { where: { id } });
    const barrier = `race-${runId}`;
    const reader = one(find, { barrierAfterFill: barrier });
    await waitAtBarrier(barrier);
    await one(op("user", "update", { data: { name: "Raced" }, where: { id } }));
    await release(barrier);
    const raced = await reader;
    expect(raced.value).toMatchObject({ name: "Before" });
    expect(raced.result.errors).toContain("write: cache write rejected: fence");
    expect((await one(find)).value).toMatchObject({ name: "Raced" });
  });

  it("invalidates rows removed by ON DELETE CASCADE", async () => {
    const userId = await seedUser();
    const postId = freshId();
    await one(op("post", "create", { data: { authorId: userId, id: postId, title: "Cascade" } }));
    const post = op("post", "findUnique", { where: { id: postId } });
    await one(post);
    expect((await one(post)).statements).toBe(0);
    await one(op("user", "delete", { where: { id: userId } }));
    expect((await one(post)).value).toBeNull();
  });

  it("returns Prisma scalar types unchanged from a hit", async () => {
    const id = freshId();
    await one({ seedMeasure: id });
    const query = op("measure", "findUnique", { where: { id } });
    const cold = await one(query);
    const hit = await one(query);
    expect(hit.statements).toBe(0);
    expect(hit.value).toEqual(cold.value);
    expect(cold.value).toMatchObject({ amount: "decimal:10.25", big: "bigint:1234567890123", blob: "bytes:0,255,7" });
  });

  it("invalidates everything when the generation changes", async () => {
    const id = await seedUser();
    const find = op("user", "findUnique", { where: { id } });
    await one(find, { generation: `a-${runId}` });
    await one({ params: ["Hidden", id], raw: "UPDATE User SET name = ? WHERE id = ?" });
    expect((await one(find, { generation: `a-${runId}` })).value).toMatchObject({ name: "Before" });
    expect((await one(find, { generation: `b-${runId}` })).value).toMatchObject({ name: "Hidden" });
  });

  it("refreshes past the soft TTL through waitUntil", async () => {
    const id = await seedUser();
    const find = op("user", "findUnique", { where: { id } });
    const shape = { freshTtlSeconds: 60, softTtlRatio: 0.01 };
    await one(find, { shape });
    await one({ params: ["Refreshed", id], raw: "UPDATE User SET name = ? WHERE id = ?" });
    await sleep(1000);
    expect((await one(find, { shape })).value).toMatchObject({ name: "Before" });
    let refreshed: unknown;
    for (let i = 0; i < 50 && !String(JSON.stringify(refreshed)).includes("Refreshed"); i++) {
      await sleep(200);
      refreshed = (await one(find, { shape })).value;
    }
    expect(refreshed).toMatchObject({ name: "Refreshed" });
  });
});
