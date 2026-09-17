import { beforeEach, describe, expect, it } from "vitest";

import type { ReadRequest } from "../../src/core/types";

import { MAX_VALUE_BYTES } from "../../src/core/limits";

import { createCoordinatorCore, FENCE_RETENTION_MS, MAX_LEASE_MS, MAX_LOCK_MS, migrate, MIGRATIONS, FENCE_COLLECT_LIMIT, PURGE_LIMIT, SWEEP_LIMIT } from "../../src/cloudflare/coordinator-core";
import { memorySql, type TestSql } from "./sqlite";

let sql: TestSql;
let core: ReturnType<typeof createCoordinatorCore>;
let tokens = 0;

beforeEach(() => {
  sql = memorySql();
  migrate(sql, sql.transact);
  tokens = 0;
  core = createCoordinatorCore(sql, () => `token-${++tokens}`, sql.transact);
});

let leases = 0;

function begin(fences: string[], leaseMs: number, now: number, generation?: string): string {
  const token = `lease-${++leases}`;
  core.beginWrite({ fences, leaseMs, token, ...(generation ? { generation } : {}) }, now);
  return token;
}

const read = (key: string, fences: string[], now: number, extra: Partial<ReadRequest> = {}) =>
  core.read({ fences, key, lockMs: 1000, refresh: false, ...extra }, now);

function miss(key: string, fences: string[], now: number) {
  const response = read(key, fences, now);
  if (response.kind !== "miss") throw new Error(`expected a miss for ${key}`);
  return response;
}

function fill(key: string, fences: string[], now: number, value = "v") {
  const response = miss(key, fences, now);
  if (!response.lockToken) throw new Error("expected a lock");
  return core.write({ key, lockToken: response.lockToken, snapshot: response.epochs, softTtlMs: 500, ttlMs: 1000, value }, now);
}

const count = (table: string) => Number(sql.all(`SELECT COUNT(*) AS n FROM ${table}`)[0]?.n);

describe("storage schema", () => {
  it("migrates idempotently and refuses storage written by newer code", () => {
    migrate(sql, sql.transact);
    expect(sql.all("SELECT version FROM schema_version")).toEqual([{ version: MIGRATIONS.length }]);
    sql.all("UPDATE schema_version SET version = 99");
    expect(() => migrate(sql, sql.transact)).toThrow(/newer than this code/);
  });
});

describe("storage upgrades", () => {
  it("upgrades storage written by schema 1 without losing entries", () => {
    const old = memorySql();
    old.all("CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)");
    old.all(MIGRATIONS[0] ?? "");
    old.all("INSERT INTO schema_version (id, version) VALUES (1, 1)");
    old.all("INSERT INTO entries (key, value, snapshot, soft_expires_at, expires_at) VALUES ('k', 'kept', '{}', 5, 10)");
    migrate(old, old.transact);
    expect(old.all("SELECT version FROM schema_version")).toEqual([{ version: MIGRATIONS.length }]);
    expect(old.all("SELECT value FROM entries")).toEqual([{ value: "kept" }]);
    expect(old.all("SELECT name FROM pragma_table_info('locks') WHERE name = 'seq'")).toEqual([{ name: "seq" }]);
  });

  it("rolls a failing migration back as a whole", () => {
    const broken = memorySql();
    broken.all("CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)");
    broken.all(MIGRATIONS[0] ?? "");
    broken.all("ALTER TABLE locks ADD COLUMN seq INTEGER");
    broken.all("INSERT INTO schema_version (id, version) VALUES (1, 1)");
    expect(() => migrate(broken, broken.transact)).toThrow();
    expect(broken.all("SELECT version FROM schema_version")).toEqual([{ version: 1 }]);
    expect(broken.all("SELECT name FROM sqlite_master WHERE name = 'generation'")).toEqual([]);
  });
});

describe("generations", () => {
  it("invalidates everything once when the generation changes, including the first one seen", () => {
    fill("k", ["g"], 0);
    expect(read("k", ["g"], 1, { generation: "v1" }).kind).toBe("miss");
    fill("k2", ["g"], 2);
    expect(read("k2", ["g"], 3, { generation: "v1" }).kind).toBe("hit");
    expect(read("k2", ["g"], 4).kind).toBe("hit");
    begin(["w:User"], 1, 5, "v2");
    expect(count("entries")).toBe(1);
    expect(read("k2", ["g"], 6).kind).toBe("miss");
  });

  it("rejects malformed generations", () => {
    expect(() => read("k", ["g"], 0, { generation: "" })).toThrow(TypeError);
    expect(() => read("k", ["g"], 0, { generation: "x".repeat(513) })).toThrow(TypeError);
  });
});

describe("fill locks", () => {
  it("grants one lock per key until it expires or is released", () => {
    expect(miss("k", ["g"], 0).lockToken).toBe("token-1");
    expect(miss("k", ["g"], 999).lockToken).toBeNull();
    expect(miss("k", ["g"], 1000).lockToken).toBe("token-2");
    core.release({ key: "k", lockToken: "token-2" });
    expect(miss("k", ["g"], 1001).lockToken).toBe("token-3");
  });

  it("caps lock duration", () => {
    miss("k", ["g"], 0);
    const capped = core.read({ fences: ["g"], key: "k2", lockMs: 10 * MAX_LOCK_MS, refresh: false }, 0);
    expect(capped.kind === "miss" && capped.lockToken).toBeTruthy();
    expect(sql.all("SELECT expires_at FROM locks WHERE key = 'k2'")).toEqual([{ expires_at: MAX_LOCK_MS }]);
  });

  it("rejects writes without the live lock", () => {
    const response = miss("k", ["g"], 0);
    const write = (lockToken: string, now: number) =>
      core.write({ key: "k", lockToken, snapshot: response.epochs, softTtlMs: 1, ttlMs: 10, value: "v" }, now);
    expect(write("other", 1)).toEqual({ ok: false, reason: "lock" });
    expect(write(response.lockToken ?? "", 1000)).toEqual({ ok: false, reason: "lock" });
    expect(count("entries")).toBe(0);
  });
});

describe("fences", () => {
  it("serves a hit only while every snapshot fence is unchanged", () => {
    expect(fill("k", ["g", "w:User"], 0)).toEqual({ ok: true });
    expect(read("k", ["g", "w:User"], 1).kind).toBe("hit");
    core.invalidate(["w:User"], 2);
    expect(read("k", ["g", "w:User"], 3).kind).toBe("miss");
    expect(count("entries")).toBe(0);
  });

  it("rejects a fill whose fences moved after capture", () => {
    const response = miss("k", ["g", "e:User:1"], 0);
    begin(["e:User:1"], 100, 1);
    const result = core.write(
      { key: "k", lockToken: response.lockToken ?? "", snapshot: response.epochs, softTtlMs: 1, ttlMs: 10, value: "old" },
      2,
    );
    expect(result).toEqual({ ok: false, reason: "fence" });
  });

  it("never reuses an epoch value, even after a fence row is collected", () => {
    core.invalidate(["e:User:1"], 0);
    const first = miss("probe", ["e:User:1"], 1).epochs["e:User:1"];
    core.invalidate(["w:Post"], FENCE_RETENTION_MS + 10);
    expect(miss("probe2", ["e:User:1"], FENCE_RETENTION_MS + 11).epochs["e:User:1"]).toBe(0);
    core.invalidate(["e:User:1"], FENCE_RETENTION_MS + 12);
    expect(miss("probe3", ["e:User:1"], FENCE_RETENTION_MS + 13).epochs["e:User:1"]).toBeGreaterThan(first ?? 0);
  });

  it("keeps a moved fence until every fill that captured it has lost its lock", () => {
    const response = core.read({ fences: ["g", "e:User:1"], key: "k", lockMs: MAX_LOCK_MS, refresh: false }, 0);
    if (response.kind !== "miss" || !response.lockToken) throw new Error("expected a lock");
    begin(["e:User:1"], 1, 1);
    for (const now of [2, MAX_LOCK_MS - 1]) {
      core.invalidate(["w:Other"], now);
      expect(sql.all("SELECT fence FROM fences WHERE fence = 'e:User:1'")).toHaveLength(1);
    }
    const result = core.write(
      { key: "k", lockToken: response.lockToken, snapshot: response.epochs, softTtlMs: 1, ttlMs: 10, value: "old" },
      MAX_LOCK_MS - 1,
    );
    expect(result).toEqual({ ok: false, reason: "fence" });
    core.invalidate(["w:Other"], FENCE_RETENTION_MS);
    expect(sql.all("SELECT fence FROM fences WHERE fence = 'e:User:1'")).toHaveLength(1);
  });
});

describe("bounded work per call", () => {
  it("deletes at most PURGE_LIMIT entries per invalidation and still misses the rest", () => {
    for (let i = 0; i < PURGE_LIMIT + 200; i++) fill(`k${i}`, ["g"], 0);
    core.invalidate(["g"], 1);
    expect(count("entries")).toBe(200);
    expect(read("k1", ["g"], 2).kind).toBe("miss");
    expect(read(`k${PURGE_LIMIT + 199}`, ["g"], 2).kind).toBe("miss");
  });
});

describe("write leases", () => {
  it("withholds fill locks while a lease is open and releases them at end or expiry", () => {
    const token = begin(["w:User"], 100, 0);
    expect(miss("k", ["g", "w:User"], 1)).toMatchObject({ lockToken: null, pending: true });
    core.endWrite({ fences: ["w:User"], token }, 2);
    expect(miss("k", ["g", "w:User"], 3)).toMatchObject({ pending: false });
    begin(["w:User"], 100, 10);
    expect(miss("k2", ["g", "w:User"], 110)).toMatchObject({ pending: false });
  });

  it("caps lease duration", () => {
    begin(["w:User"], 10 * MAX_LEASE_MS, 0);
    expect(sql.all("SELECT expires_at FROM leases")).toEqual([{ expires_at: MAX_LEASE_MS }]);
  });

  it("purges entries under the written fences at end of write", () => {
    fill("a", ["g", "w:User"], 0);
    fill("b", ["g", "w:Post"], 0);
    const token = begin(["w:User"], 100, 1);
    core.endWrite({ fences: ["w:User"], token }, 2);
    expect(sql.all("SELECT key FROM entries")).toEqual([{ key: "b" }]);
    expect(count("leases")).toBe(0);
  });
});

describe("refresh", () => {
  it("hands out a refresh lock only past the soft TTL and outside a lease", () => {
    fill("k", ["g"], 0);
    const early = read("k", ["g"], 100, { refresh: true });
    expect(early.kind === "hit" && early.refreshToken).toBeNull();
    const late = read("k", ["g"], 600, { refresh: true });
    expect(late.kind === "hit" && late.refreshToken).toBeTruthy();
    core.release({ key: "k", lockToken: late.kind === "hit" ? (late.refreshToken ?? "") : "" });
    begin(["w:Other"], 1000, 601);
    const leased = read("k", ["g", "w:Other"], 602, { refresh: true });
    expect(leased.kind === "hit" && leased.refreshToken).toBeNull();
  });
});

describe("sweep", () => {
  it("removes expired entries, locks, leases and old unreferenced entity fences", () => {
    fill("old", ["g"], 0);
    miss("locked", ["g"], 0);
    begin(["w:User"], 5, 0);
    core.invalidate(["e:User:1", "e:User:2"], 0);
    fill("keeps-e2", ["g", "e:User:2"], FENCE_RETENTION_MS - 5);
    core.invalidate(["w:Unrelated"], FENCE_RETENTION_MS + 1);
    expect(sql.all("SELECT key FROM entries ORDER BY key")).toEqual([{ key: "keeps-e2" }]);
    expect(sql.all("SELECT key FROM locks")).toEqual([]);
    expect(count("leases")).toBe(0);
    expect(sql.all("SELECT fence FROM fences WHERE fence LIKE 'e:%' ORDER BY fence")).toEqual([{ fence: "e:User:2" }]);
    expect(sql.all("SELECT fence FROM fences WHERE fence = 'w:User'")).toHaveLength(1);
  });

  it("sweeps on fill writes, never on reads", () => {
    fill("old", ["g"], 0);
    miss("other", ["g"], 5000);
    expect(sql.all("SELECT key FROM entries")).toEqual([{ key: "old" }]);
    core.release({ key: "other", lockToken: "token-2" });
    fill("other", ["g"], 5001);
    expect(sql.all("SELECT key FROM entries")).toEqual([{ key: "other" }]);
  });

  it("keeps young entity fences", () => {
    core.invalidate(["e:User:1"], 0);
    core.invalidate(["w:Other"], FENCE_RETENTION_MS - 1);
    expect(sql.all("SELECT fence FROM fences WHERE fence = 'e:User:1'")).toHaveLength(1);
  });
});

describe("review fixes in the coordinator", () => {
  it("makes a retried beginWrite with the same token leave no orphan lease", () => {
    core.beginWrite({ fences: ["w:User"], leaseMs: 1000, token: "same" }, 0);
    core.beginWrite({ fences: ["w:User"], leaseMs: 1000, token: "same" }, 1);
    core.endWrite({ fences: ["w:User"], token: "same" }, 2);
    expect(count("leases")).toBe(0);
    expect(miss("k", ["g", "w:User"], 3).pending).toBe(false);
  });

  it("rejects a fill that captured a missing fence before it was collected, even if the clock went back", () => {
    for (let i = 0; i < SWEEP_LIMIT + 10; i++) miss(`older-${i}`, ["g"], 0);
    const response = miss("k", ["g", "e:User:1"], 0);
    core.invalidate(["e:User:1"], 1);
    core.invalidate(["w:Other"], FENCE_RETENTION_MS + 10);
    expect(sql.all("SELECT fence FROM fences WHERE fence = 'e:User:1'")).toEqual([]);
    const result = core.write(
      { key: "k", lockToken: response.lockToken ?? "", snapshot: response.epochs, softTtlMs: 1, ttlMs: 10, value: "old" },
      5,
    );
    expect(result).toEqual({ ok: false, reason: "fence" });
  });

  it("keeps collecting past fences that cannot be deleted yet", () => {
    const held = Array.from({ length: FENCE_COLLECT_LIMIT + 10 }, (_, i) => `e:A:${String(i).padStart(3, "0")}`);
    core.invalidate(held, 1);
    held.forEach((fence, i) => fill(`held-${i}`, ["g", fence], 2));
    sql.all("UPDATE entries SET expires_at = ?", 10 * FENCE_RETENTION_MS);
    core.invalidate(["e:Z:loose"], 3);
    for (let round = 0; round < 4; round++) core.invalidate(["w:Tick"], FENCE_RETENTION_MS + 10 + round);
    expect(sql.all("SELECT fence FROM fences WHERE fence = 'e:Z:loose'")).toEqual([]);
  });

  it("does not reject fills just because unrelated old fences were collected after their lock", () => {
    core.invalidate(["e:Old:1"], 0);
    const response = miss("k", ["g", "e:User:9"], FENCE_RETENTION_MS + 5);
    expect(sql.all("SELECT fence FROM fences WHERE fence = 'e:Old:1'")).toHaveLength(1);
    const token = begin(["w:Other"], 10, FENCE_RETENTION_MS + 6);
    core.endWrite({ fences: ["w:Other"], token }, FENCE_RETENTION_MS + 7);
    expect(sql.all("SELECT fence FROM fences WHERE fence = 'e:Old:1'")).toEqual([]);
    const result = core.write(
      { key: "k", lockToken: response.lockToken ?? "", snapshot: response.epochs, softTtlMs: 1, ttlMs: 10, value: "v" },
      FENCE_RETENTION_MS + 8,
    );
    expect(result).toEqual({ ok: true });
  });

  it("never collects the fences a fill is about to write", () => {
    core.invalidate(["e:User:1"], 0);
    expect(fill("k", ["g", "e:User:1"], FENCE_RETENTION_MS + 1)).toEqual({ ok: true });
    expect(read("k", ["g", "e:User:1"], FENCE_RETENTION_MS + 2).kind).toBe("hit");
  });

  it("lets a fill take over a refresh lock once the entry is gone, and reports how long a fill lock has been held", () => {
    fill("k", ["g"], 0);
    const hit = read("k", ["g"], 600, { refresh: true });
    expect(hit.kind === "hit" && hit.refreshToken).toBeTruthy();
    core.invalidate(["g"], 601);
    const takeover = miss("k", ["g"], 602);
    expect(takeover.lockToken).toBeTruthy();
    expect(miss("k", ["g"], 700)).toMatchObject({ lockHeldForMs: 98, lockToken: null });
  });

  it("evicts the entries closest to expiry to stay within the stored-bytes budget", () => {
    const small = createCoordinatorCore(sql, () => `s-${++tokens}`, sql.transact, { maxStoredBytes: 250 });
    const put = (key: string, ttlMs: number, now: number) => {
      const response = small.read({ fences: ["g"], key, lockMs: 100, refresh: false }, now);
      if (response.kind !== "miss" || !response.lockToken) throw new Error("expected a lock");
      return small.write({ key, lockToken: response.lockToken, snapshot: response.epochs, softTtlMs: 1, ttlMs, value: "x".repeat(100) }, now);
    };
    expect(put("soon", 1000, 0)).toEqual({ ok: true });
    expect(put("later", 5000, 1)).toEqual({ ok: true });
    expect(put("latest", 9000, 2)).toEqual({ ok: true });
    expect(sql.all("SELECT key FROM entries ORDER BY key")).toEqual([{ key: "later" }, { key: "latest" }]);
    expect(Number(sql.all("SELECT value FROM meta WHERE key = 'entry_bytes'")[0]?.value)).toBeLessThanOrEqual(250);
    expect(put("huge", 9000, 3)).toEqual({ ok: true });
    const tooBig = createCoordinatorCore(sql, () => `t-${++tokens}`, sql.transact, { maxStoredBytes: 50 });
    const response = tooBig.read({ fences: ["g"], key: "big", lockMs: 100, refresh: false }, 4);
    if (response.kind !== "miss" || !response.lockToken) throw new Error("expected a lock");
    expect(tooBig.write({ key: "big", lockToken: response.lockToken, snapshot: response.epochs, softTtlMs: 1, ttlMs: 10, value: "y".repeat(100) }, 4)).toEqual({
      ok: false,
      reason: "full",
    });
  });

  it("refuses oversize values as an invalid write instead of storing them", () => {
    const response = miss("k", ["g"], 0);
    const result = core.write(
      { key: "k", lockToken: response.lockToken ?? "", snapshot: response.epochs, softTtlMs: 1, ttlMs: 10, value: "x".repeat(MAX_VALUE_BYTES + 1) },
      1,
    );
    expect(result).toEqual({ ok: false, reason: "invalid" });
    expect(count("entries")).toBe(0);
    expect(count("locks")).toBe(0);
  });

  it("runs every call inside one transaction", () => {
    let transactions = 0;
    const counted = createCoordinatorCore(sql, () => "t", (run) => {
      transactions++;
      return sql.transact(run);
    });
    counted.read({ fences: ["g"], key: "k", lockMs: 10, refresh: false }, 0);
    counted.write({ key: "k", lockToken: "t", snapshot: { g: 0 }, softTtlMs: 1, ttlMs: 10, value: "v" }, 1);
    counted.release({ key: "k", lockToken: "t" });
    counted.beginWrite({ fences: ["w:User"], leaseMs: 10, token: "b" }, 2);
    counted.endWrite({ fences: ["w:User"], token: "b" }, 3);
    counted.invalidate(["w:User"], 4);
    expect(transactions).toBe(6);
  });
});

describe("request validation", () => {
  it("rejects oversized keys and fence lists on every call", () => {
    expect(() => read("k".repeat(2000), ["g"], 0)).toThrow(TypeError);
    expect(() => read("k", Array.from({ length: 6000 }, (_, i) => `e:X:${i}`), 0)).toThrow(TypeError);
    expect(() => core.invalidate(["x".repeat(600)], 0)).toThrow(TypeError);
    expect(() => core.release({ key: "k".repeat(2000), lockToken: "t" })).toThrow(TypeError);
  });

  it("rejects malformed requests from mismatched callers", () => {
    expect(() => core.read({ fences: JSON.parse('"g"'), key: "k", lockMs: 1, refresh: false }, 0)).toThrow(TypeError);
    expect(() => core.beginWrite({ fences: ["g"], leaseMs: Number.NaN, token: "t" }, 0)).toThrow(TypeError);
    expect(() => core.beginWrite({ fences: ["g"], leaseMs: 1, token: "" }, 0)).toThrow(TypeError);
    expect(() =>
      core.write({ key: "k", lockToken: "t", snapshot: { g: 1.5 }, softTtlMs: 1, ttlMs: 1, value: "v" }, 0),
    ).toThrow(TypeError);
  });
});
