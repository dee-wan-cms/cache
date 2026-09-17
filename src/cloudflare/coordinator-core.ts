import type {
  BeginWriteRequest,
  EndWriteRequest,
  ReadRequest,
  ReadResponse,
  ReleaseRequest,
  WriteRequest,
  WriteResult,
} from "../core/types";

import { GLOBAL_FENCE } from "../core/fences";
import {
  MAX_COORDINATOR_GENERATION_LENGTH,
  MAX_LEASE_MS,
  MAX_LOCK_MS,
  MAX_TTL_MS,
  MAX_VALUE_BYTES,
} from "../core/limits";

export type SqlValue = ArrayBuffer | null | number | string;

export type Row = Record<string, SqlValue>;

export interface SqlLike {
  exec(query: string, ...bindings: SqlValue[]): { toArray(): Row[] };
}

export type Transact = <T>(run: () => T) => T;

export interface CoordinatorLimits {
  maxStoredBytes?: number;
}

export { MAX_LEASE_MS, MAX_LOCK_MS, MAX_TTL_MS };
export const FENCE_RETENTION_MS = 2 * MAX_LOCK_MS;
export const SWEEP_LIMIT = 50;
export const FENCE_COLLECT_LIMIT = 100;
export const PURGE_LIMIT = 500;
export const EVICTION_BATCH = 50;
export const MAX_EVICTION_ROUNDS = 20;
export const MAX_STORED_BYTES = 1024 * 1024 * 1024;
export const MAX_KEY_LENGTH = 1024;
export const MAX_TOKEN_LENGTH = 128;
export const MAX_FENCE_LENGTH = 512;
export const MAX_FENCES_PER_REQUEST = 5000;

const MAX_BOUND_PARAMETERS = 90;

export const MIGRATIONS: readonly string[] = [
  `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT OR IGNORE INTO meta (key, value) VALUES ('sequence', 0);
CREATE TABLE IF NOT EXISTS fences (fence TEXT PRIMARY KEY, epoch INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS fences_by_updated ON fences (updated_at);
CREATE TABLE IF NOT EXISTS leases (token TEXT NOT NULL, fence TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (token, fence));
CREATE INDEX IF NOT EXISTS leases_by_fence ON leases (fence, expires_at);
CREATE INDEX IF NOT EXISTS leases_by_expiry ON leases (expires_at);
CREATE TABLE IF NOT EXISTS locks (key TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS locks_by_expiry ON locks (expires_at);
CREATE TABLE IF NOT EXISTS entries (key TEXT PRIMARY KEY, value TEXT NOT NULL, snapshot TEXT NOT NULL, soft_expires_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS entries_by_expiry ON entries (expires_at);
CREATE TABLE IF NOT EXISTS entry_fences (fence TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY (fence, key));
CREATE INDEX IF NOT EXISTS entry_fences_by_key ON entry_fences (key);
`,
  `
CREATE TABLE IF NOT EXISTS generation (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL);
`,
  `
ALTER TABLE locks ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE locks ADD COLUMN kind TEXT NOT NULL DEFAULT 'fill';
ALTER TABLE locks ADD COLUMN acquired_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entries ADD COLUMN size INTEGER NOT NULL DEFAULT 0;
INSERT OR IGNORE INTO meta (key, value) VALUES ('gc_watermark', 0);
INSERT OR IGNORE INTO meta (key, value) VALUES ('entry_bytes', 0);
CREATE TABLE IF NOT EXISTS gc_cursor (id INTEGER PRIMARY KEY CHECK (id = 1), updated_at INTEGER NOT NULL, fence TEXT NOT NULL);
INSERT OR IGNORE INTO gc_cursor (id, updated_at, fence) VALUES (1, -1, '');
CREATE INDEX IF NOT EXISTS fences_by_updated_fence ON fences (updated_at, fence);
`,
];

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += MAX_BOUND_PARAMETERS) out.push(items.slice(i, i + MAX_BOUND_PARAMETERS));
  return out;
}

const placeholders = (count: number): string => Array.from({ length: count }, () => "?").join(",");

const clamp = (value: number, max: number): number => Math.min(Math.max(Math.trunc(value), 1), max);

function assertRequest(condition: boolean, message: string): asserts condition {
  if (!condition) throw new TypeError(`cache coordinator: ${message}`);
}

const isKey = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_KEY_LENGTH;

const isFenceList = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= MAX_FENCES_PER_REQUEST &&
  value.every((fence) => typeof fence === "string" && fence.length > 0 && fence.length <= MAX_FENCE_LENGTH);

const isSnapshot = (value: unknown): value is Record<string, number> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length <= MAX_FENCES_PER_REQUEST &&
  Object.values(value).every((epoch) => Number.isSafeInteger(epoch));

const isGeneration = (value: unknown): value is string | undefined =>
  value === undefined ||
  (typeof value === "string" && value.length > 0 && value.length <= MAX_COORDINATOR_GENERATION_LENGTH);

const isToken = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_TOKEN_LENGTH;

const isDuration = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

const byteLength = (text: string): number => new TextEncoder().encode(text).byteLength;

function parseSnapshot(text: string): Record<string, number> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function migrate(sql: SqlLike, transact: Transact): void {
  transact(() => {
    sql.exec("CREATE TABLE IF NOT EXISTS schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)");
    const current = Number(sql.exec("SELECT version FROM schema_version WHERE id = 1").toArray()[0]?.version ?? 0);
    if (current > MIGRATIONS.length) {
      throw new Error(`cache coordinator: storage schema ${current} is newer than this code (${MIGRATIONS.length})`);
    }
    if (current === MIGRATIONS.length) return;
    MIGRATIONS.slice(current).forEach((migration) => sql.exec(migration));
    sql.exec("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, ?)", MIGRATIONS.length);
  });
}

export function createCoordinatorCore(sql: SqlLike, newToken: () => string, transact: Transact, limits: CoordinatorLimits = {}) {
  const maxStoredBytes = limits.maxStoredBytes ?? MAX_STORED_BYTES;
  const rows = (query: string, ...bindings: SqlValue[]): Row[] => sql.exec(query, ...bindings).toArray();

  const metaValue = (key: string): number => Number(rows("SELECT value FROM meta WHERE key = ?", key)[0]?.value ?? 0);

  function epochs(fences: string[]): Record<string, number> {
    const out: Record<string, number> = Object.fromEntries(fences.map((fence) => [fence, 0]));
    for (const chunk of chunks([...new Set(fences)])) {
      for (const row of rows(`SELECT fence, epoch FROM fences WHERE fence IN (${placeholders(chunk.length)})`, ...chunk)) {
        out[String(row.fence)] = Number(row.epoch);
      }
    }
    return out;
  }

  const matches = (snapshot: Record<string, number>, current: Record<string, number>): boolean => {
    const fences = Object.keys(snapshot);
    return fences.length > 0 && fences.every((fence) => current[fence] === snapshot[fence]);
  };

  const pending = (fences: string[], now: number): boolean =>
    chunks([...new Set(fences)]).some(
      (chunk) => rows(`SELECT 1 FROM leases WHERE expires_at > ? AND fence IN (${placeholders(chunk.length)}) LIMIT 1`, now, ...chunk).length > 0,
    );

  function writeLock(key: string, lockMs: number, now: number, kind: "fill" | "refresh"): string {
    const token = newToken();
    sql.exec(
      "INSERT OR REPLACE INTO locks (key, token, expires_at, seq, kind, acquired_at) VALUES (?, ?, ?, ?, ?, ?)",
      key,
      token,
      now + clamp(lockMs, MAX_LOCK_MS),
      metaValue("sequence"),
      kind,
      now,
    );
    return token;
  }

  function deleteEntries(keys: string[]): void {
    for (const chunk of chunks(keys)) {
      const bytes = Number(rows(`SELECT COALESCE(SUM(size), 0) AS bytes FROM entries WHERE key IN (${placeholders(chunk.length)})`, ...chunk)[0]?.bytes ?? 0);
      sql.exec(`DELETE FROM entry_fences WHERE key IN (${placeholders(chunk.length)})`, ...chunk);
      sql.exec(`DELETE FROM entries WHERE key IN (${placeholders(chunk.length)})`, ...chunk);
      if (bytes > 0) sql.exec("UPDATE meta SET value = MAX(0, value - ?) WHERE key = 'entry_bytes'", bytes);
    }
  }

  function makeRoom(size: number): boolean {
    for (let round = 0; round < MAX_EVICTION_ROUNDS; round++) {
      const overflow = metaValue("entry_bytes") + size - maxStoredBytes;
      if (overflow <= 0) return true;
      const candidates = rows("SELECT key, size FROM entries ORDER BY expires_at LIMIT ?", EVICTION_BATCH);
      if (candidates.length === 0) break;
      let freed = 0;
      const victims = candidates.filter((row) => {
        if (freed >= overflow) return false;
        freed += Number(row.size);
        return true;
      });
      deleteEntries(victims.map((row) => String(row.key)));
    }
    return metaValue("entry_bytes") + size <= maxStoredBytes;
  }

  function bump(fences: string[], now: number): void {
    for (const fence of new Set(fences)) {
      const next = Number(rows("UPDATE meta SET value = value + 1 WHERE key = 'sequence' RETURNING value")[0]?.value);
      sql.exec(
        "INSERT INTO fences (fence, epoch, updated_at) VALUES (?, ?, ?) ON CONFLICT (fence) DO UPDATE SET epoch = excluded.epoch, updated_at = excluded.updated_at",
        fence,
        next,
        now,
      );
    }
  }

  function purge(fences: string[]): void {
    let budget = PURGE_LIMIT;
    for (const chunk of chunks([...new Set(fences)])) {
      if (budget <= 0) return;
      const keys = rows(
        `SELECT DISTINCT key FROM entry_fences WHERE fence IN (${placeholders(chunk.length)}) LIMIT ?`,
        ...chunk,
        budget,
      );
      deleteEntries(keys.map((row) => String(row.key)));
      budget -= keys.length;
    }
  }

  function collectFences(now: number): void {
    const cursor = rows("SELECT updated_at, fence FROM gc_cursor WHERE id = 1")[0];
    const after = Number(cursor?.updated_at ?? -1);
    const afterFence = String(cursor?.fence ?? "");
    const batch = rows(
      `SELECT fence, updated_at, epoch,
         EXISTS (SELECT 1 FROM entry_fences WHERE entry_fences.fence = fences.fence) AS in_entries,
         EXISTS (SELECT 1 FROM leases WHERE leases.fence = fences.fence) AS in_leases
       FROM fences
       WHERE (updated_at, fence) > (?, ?) AND updated_at <= ? AND fence >= ? AND fence < ?
       ORDER BY updated_at, fence LIMIT ?`,
      after,
      afterFence,
      now - FENCE_RETENTION_MS,
      "e:",
      "e;",
      FENCE_COLLECT_LIMIT,
    );
    const deletable = batch.filter((row) => Number(row.in_entries) === 0 && Number(row.in_leases) === 0);
    for (const chunk of chunks(deletable.map((row) => String(row.fence)))) {
      sql.exec(`DELETE FROM fences WHERE fence IN (${placeholders(chunk.length)})`, ...chunk);
    }
    const highestDeletedEpoch = Math.max(0, ...deletable.map((row) => Number(row.epoch)));
    if (highestDeletedEpoch > 0) {
      sql.exec("UPDATE meta SET value = MAX(value, ?) WHERE key = 'gc_watermark'", highestDeletedEpoch);
    }
    const last = batch[batch.length - 1];
    const [nextAt, nextFence] = batch.length < FENCE_COLLECT_LIMIT || !last ? [-1, ""] : [Number(last.updated_at), String(last.fence)];
    if (nextAt !== after || nextFence !== afterFence) {
      sql.exec("UPDATE gc_cursor SET updated_at = ?, fence = ? WHERE id = 1", nextAt, nextFence);
    }
  }

  function sweep(now: number): void {
    const expired = rows("SELECT key FROM entries WHERE expires_at <= ? LIMIT ?", now, SWEEP_LIMIT);
    deleteEntries(expired.map((row) => String(row.key)));
    sql.exec("DELETE FROM leases WHERE rowid IN (SELECT rowid FROM leases WHERE expires_at <= ? LIMIT ?)", now, SWEEP_LIMIT);
    sql.exec("DELETE FROM locks WHERE rowid IN (SELECT rowid FROM locks WHERE expires_at <= ? LIMIT ?)", now, SWEEP_LIMIT);
    collectFences(now);
  }

  function observeGeneration(generation: string | undefined, now: number): void {
    if (generation === undefined) return;
    const current = rows("SELECT value FROM generation WHERE id = 1")[0]?.value;
    if (current === generation) return;
    bump([GLOBAL_FENCE], now);
    sql.exec("INSERT OR REPLACE INTO generation (id, value) VALUES (1, ?)", generation);
  }

  function snapshotValid(snapshot: Record<string, number> | null): snapshot is Record<string, number> {
    return snapshot !== null && matches(snapshot, epochs(Object.keys(snapshot)));
  }

  return {
    beginWrite(request: BeginWriteRequest, now: number): void {
      assertRequest(
        isFenceList(request.fences) && isDuration(request.leaseMs) && isGeneration(request.generation) && isToken(request.token),
        "invalid beginWrite request",
      );
      transact(() => {
        observeGeneration(request.generation, now);
        bump(request.fences, now);
        const expiresAt = now + clamp(request.leaseMs, MAX_LEASE_MS);
        for (const fence of new Set(request.fences)) {
          sql.exec("INSERT OR REPLACE INTO leases (token, fence, expires_at) VALUES (?, ?, ?)", request.token, fence, expiresAt);
        }
      });
    },

    endWrite(request: EndWriteRequest, now: number): void {
      assertRequest(isFenceList(request.fences) && isToken(request.token), "invalid endWrite request");
      transact(() => {
        bump(request.fences, now);
        sql.exec("DELETE FROM leases WHERE token = ?", request.token);
        purge(request.fences);
        sweep(now);
      });
    },

    invalidate(fences: string[], now: number): void {
      assertRequest(isFenceList(fences), "invalid invalidate request");
      transact(() => {
        bump(fences, now);
        purge(fences);
        sweep(now);
      });
    },

    read(request: ReadRequest, now: number): ReadResponse {
      assertRequest(
        isKey(request.key) && isFenceList(request.fences) && isDuration(request.lockMs) && isGeneration(request.generation),
        "invalid read request",
      );
      return transact((): ReadResponse => {
        observeGeneration(request.generation, now);
        const entry = rows("SELECT value, snapshot, soft_expires_at, expires_at FROM entries WHERE key = ?", request.key)[0];
        const lock = rows("SELECT expires_at, kind, acquired_at FROM locks WHERE key = ?", request.key)[0];
        const lockLive = lock !== undefined && Number(lock.expires_at) > now;
        if (entry && Number(entry.expires_at) > now) {
          const snapshot = parseSnapshot(String(entry.snapshot));
          const current = epochs([...request.fences, ...Object.keys(snapshot ?? {})]);
          if (snapshot && matches(snapshot, current)) {
            const refreshable =
              request.refresh === true && now >= Number(entry.soft_expires_at) && !lockLive && !pending(request.fences, now);
            return {
              epochs: Object.fromEntries(request.fences.map((fence) => [fence, current[fence] ?? 0])),
              kind: "hit",
              refreshToken: refreshable ? writeLock(request.key, request.lockMs, now, "refresh") : null,
              value: String(entry.value),
            };
          }
        }
        if (entry) deleteEntries([request.key]);
        const isPending = pending(request.fences, now);
        const heldByFill = lockLive && lock.kind !== "refresh";
        const lockToken = isPending || heldByFill ? null : writeLock(request.key, request.lockMs, now, "fill");
        return {
          epochs: epochs(request.fences),
          kind: "miss",
          lockHeldForMs: heldByFill ? Math.max(0, now - Number(lock.acquired_at)) : null,
          lockToken,
          pending: isPending,
        };
      });
    },

    release(request: ReleaseRequest): void {
      assertRequest(isKey(request.key) && isToken(request.lockToken), "invalid release request");
      transact(() => sql.exec("DELETE FROM locks WHERE key = ? AND token = ?", request.key, request.lockToken));
    },

    write(request: WriteRequest, now: number): WriteResult {
      assertRequest(
        typeof request.key === "string" &&
          typeof request.lockToken === "string" &&
          typeof request.value === "string" &&
          isSnapshot(request.snapshot) &&
          isDuration(request.ttlMs) &&
          isDuration(request.softTtlMs),
        "invalid write request",
      );
      return transact((): WriteResult => {
        const lock = rows("SELECT token, expires_at, seq FROM locks WHERE key = ?", request.key)[0];
        if (!lock || lock.token !== request.lockToken || Number(lock.expires_at) <= now) return { ok: false, reason: "lock" };
        sql.exec("DELETE FROM locks WHERE key = ?", request.key);
        const snapshotText = JSON.stringify(request.snapshot);
        const size = byteLength(request.value) + snapshotText.length + request.key.length;
        const oversize = !isKey(request.key) || request.ttlMs > MAX_TTL_MS || byteLength(request.value) > MAX_VALUE_BYTES;
        if (oversize) return { ok: false, reason: "invalid" };
        const capturedMissing = Object.values(request.snapshot).some((epoch) => epoch === 0);
        if (capturedMissing && Number(lock.seq) < metaValue("gc_watermark")) return { ok: false, reason: "fence" };
        if (!snapshotValid(request.snapshot)) return { ok: false, reason: "fence" };
        deleteEntries([request.key]);
        if (!makeRoom(size)) return { ok: false, reason: "full" };
        sql.exec(
          "INSERT INTO entries (key, value, snapshot, soft_expires_at, expires_at, size) VALUES (?, ?, ?, ?, ?, ?)",
          request.key,
          request.value,
          snapshotText,
          now + Math.min(request.softTtlMs, request.ttlMs),
          now + request.ttlMs,
          size,
        );
        sql.exec("UPDATE meta SET value = value + ? WHERE key = 'entry_bytes'", size);
        for (const fence of Object.keys(request.snapshot)) {
          sql.exec("INSERT INTO entry_fences (fence, key) VALUES (?, ?)", fence, request.key);
        }
        sweep(now);
        return { ok: true };
      });
    },
  };
}

export type CoordinatorCore = ReturnType<typeof createCoordinatorCore>;
