import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Miniflare } from "miniflare";

const BUILD = join(import.meta.dirname, ".build");
const COMPATIBILITY_DATE = "2025-08-01";
const DATABASE_ID = "cache-test-db";

export type WorkerName = "cache-test-a" | "cache-test-b";

export interface StepResult {
  error?: string;
  value?: unknown;
}

export interface RunResult {
  errors: string[];
  inner: number;
  cacheReads: number;
  inspections: number;
  results: StepResult[];
  statements: number;
}

type FixtureResponse = { status: number; headers: { get(name: string): string | null }; clone(): FixtureResponse; text(): Promise<string>; json(): Promise<unknown> };

export interface Rig {
  barrierState(name: string): Promise<null | string>;
  dispose(): Promise<void>;
  isolateId(worker: WorkerName): Promise<string>;
  release(name: string): Promise<void>;
  sessionBatch(name: string): Promise<FixtureResponse>;
  sessionUnique(name: string, sequential?: boolean): Promise<FixtureResponse>;
  sessionPendingWriteRace(): Promise<FixtureResponse>;
  sessionWarmWriteRace(): Promise<FixtureResponse>;
  warmAbort(path: string, method?: string): Promise<FixtureResponse>;
  session(name: string, init?: { method?: string; headers?: Record<string, string> }): Promise<FixtureResponse>;
  statusWithoutToken(): Promise<number>;
  reset(): Promise<void>;
  run(body: Record<string, unknown>, worker?: WorkerName): Promise<RunResult>;
}

const SMOKE_TOKEN = "rig-token";

const workerOptions = (name: string, entry: string) => ({
  bindings: { SMOKE_TOKEN },
  compatibilityDate: COMPATIBILITY_DATE,
  compatibilityFlags: ["nodejs_compat"],
  d1Databases: { DB: DATABASE_ID, OTHER: "cache-test-control" },
  modules: true,
  modulesRules: [{ include: ["**/*.wasm"], type: "CompiledWasm" as const }],
  name,
  scriptPath: join(BUILD, entry),
});

export async function startRig(): Promise<Rig> {
  const mf = new Miniflare({
    workers: [
      { ...workerOptions("cache-test-a", "a/a.js"), durableObjects: { COORDINATOR: { className: "CacheCoordinator", useSQLite: true } } },
      {
        ...workerOptions("cache-test-b", "b/b.js"),
        durableObjects: { COORDINATOR: { className: "CacheCoordinator", scriptName: "cache-test-a", useSQLite: true } },
      },
    ],
  });
  let db: Awaited<ReturnType<typeof mf.getD1Database>>;
  try {
    await mf.ready;
    db = await mf.getD1Database("DB", "cache-test-a");
    const ddl = readFileSync(join(BUILD, "schema.sql"), "utf8")
      .split(/;\s*\n/)
      .map((statement) => statement.replace(/^--.*$/gm, "").trim())
      .filter((statement) => statement.length > 0);
    for (const statement of ddl) await db.prepare(statement).run();
    const other = await mf.getD1Database("OTHER", "cache-test-a");
    await other.prepare('CREATE TABLE IF NOT EXISTS ControlState (id INTEGER PRIMARY KEY, value TEXT)').run();
    await other.prepare("INSERT OR REPLACE INTO ControlState (id,value) VALUES (1,'initial')").run();
  } catch (error) {
    await mf.dispose();
    throw error;
  }
  const tables = ["_PostToTag", "Post", "Tag", "Profile", "User", "Secret", "Barrier", "Measure"];

  const fetchJson = async <T>(worker: WorkerName, path: string, init?: { body?: string; headers?: Record<string, string>; method?: string }): Promise<T> => {
    const fetcher = await mf.getWorker(worker);
    const response = await fetcher.fetch(`http://rig${path}`, { ...init, headers: { ...init?.headers, "x-smoke-token": SMOKE_TOKEN } });
    const text = await response.text();
    if (!response.ok) throw new Error(`${worker} ${path}: ${response.status} ${text}`);
    return JSON.parse(text);
  };

  return {
    barrierState: async (name) =>
      (await fetchJson<{ state: null | string }>("cache-test-a", `/barrier?name=${encodeURIComponent(name)}`)).state,
    dispose: () => mf.dispose(),
    isolateId: async (worker) => (await fetchJson<{ isolateId: string }>(worker, "/isolate")).isolateId,
    sessionBatch: async (name) => {
      const fetcher = await mf.getWorker('cache-test-a');
      return fetcher.fetch(`http://rig/session?name=${encodeURIComponent(name)}&batch=1`, { headers:{ 'x-smoke-token':SMOKE_TOKEN } });
    },
    sessionUnique: async (name, sequential) => {
      const fetcher = await mf.getWorker('cache-test-a');
      return fetcher.fetch(`http://rig/session?name=${encodeURIComponent(name)}&unique=1${sequential ? '&sequential=1' : ''}`, { headers:{ 'x-smoke-token':SMOKE_TOKEN } });
    },
    sessionPendingWriteRace: async () => {
      const fetcher = await mf.getWorker('cache-test-a');
      return fetcher.fetch('http://rig/session-pending-write-race', { headers:{ 'x-smoke-token':SMOKE_TOKEN } });
    },
    sessionWarmWriteRace: async () => {
      const fetcher = await mf.getWorker('cache-test-a');
      return fetcher.fetch('http://rig/session-warm-write-race', { headers:{ 'x-smoke-token':SMOKE_TOKEN } });
    },
    warmAbort: async (path, method = 'GET') => {
      const fetcher = await mf.getWorker('cache-test-a');
      return fetcher.fetch(`http://rig/warm-abort/${path}`, { method, headers:{ 'x-smoke-token':SMOKE_TOKEN, cookie:'session=actor', 'x-site-id':'site-a' } });
    },
    session: async (name, init) => {
      const fetcher = await mf.getWorker('cache-test-a');
      return fetcher.fetch(`http://rig/session?name=${encodeURIComponent(name)}`, { ...init, headers:{ ...init?.headers, 'x-smoke-token':SMOKE_TOKEN } });
    },
    release: async (name) => {
      await fetchJson("cache-test-a", `/barrier?name=${encodeURIComponent(name)}`, { method: "POST" });
    },
    statusWithoutToken: async () => (await (await mf.getWorker("cache-test-a")).fetch("http://rig/isolate")).status,
    reset: async () => {
      for (const table of tables) await db.prepare(`DELETE FROM "${table}"`).run();
      await db.prepare("DELETE FROM sqlite_sequence").run().catch(() => undefined);
    },
    run: (body, worker = "cache-test-a") =>
      fetchJson<RunResult>(worker, "/run", { body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "POST" }),
  };
}

export async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, label: string): Promise<T> {
  for (let i = 0; i < 500; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}
