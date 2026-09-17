import { describe, expect, it } from "vitest";

import { createCoordinatorCore, migrate } from "../../src/cloudflare/coordinator-core";
import { memorySql } from "./sqlite";

const KEY = "User:1";
const READ_FENCES = ["g", "m:User", "w:User", "e:User:1"];
const WRITE_FENCES = ["w:User", "e:User:1"];

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Scenario {
  dropEnd: boolean;
  leaseMs: (random: () => number) => number;
}

interface WriteState {
  commitAt?: number;
  ended: boolean;
  leaseExpiredBeforeCommit: boolean;
}

type Actor = () => boolean;

function simulate(seed: number, scenario: Scenario) {
  const random = prng(seed);
  const sql = memorySql();
  migrate(sql, sql.transact);
  let tokens = 0;
  const core = createCoordinatorCore(sql, () => `t${++tokens}`, sql.transact);
  let now = 0;
  let version = 0;
  let hits = 0;
  let rejected = 0;
  const violations: string[] = [];
  const writes: WriteState[] = [];

  const staleAllowed = () => writes.some((write) => write.commitAt !== undefined && !write.ended && write.leaseExpiredBeforeCommit);

  const observe = (value: string) => {
    hits++;
    if (Number(value) !== version && !staleAllowed()) violations.push(`seed ${seed} t=${now}: hit ${value}, database ${version}`);
  };

  function writer(rounds: number): Actor {
    let phase = 0;
    let round = 0;
    let token = "";
    let leaseEnds = 0;
    let state: WriteState = { ended: false, leaseExpiredBeforeCommit: false };
    return () => {
      if (phase === 0) {
        if (random() < 0.7) return false;
        const leaseMs = scenario.leaseMs(random);
        token = `lease-${++tokens}`;
        core.beginWrite({ fences: WRITE_FENCES, leaseMs, token }, now);
        leaseEnds = now + leaseMs;
        state = { ended: false, leaseExpiredBeforeCommit: false };
        writes.push(state);
      } else if (phase === 1) {
        version++;
        state.commitAt = now;
        state.leaseExpiredBeforeCommit = now >= leaseEnds;
      } else {
        if (!scenario.dropEnd) {
          core.endWrite({ fences: WRITE_FENCES, token }, now);
          state.ended = true;
        }
        round++;
      }
      phase = (phase + 1) % 3;
      return phase === 0 && round >= rounds;
    };
  }

  function reader(rounds: number): Actor {
    let phase = 0;
    let round = 0;
    let lockToken: null | string = null;
    let epochs: Record<string, number> = {};
    let seen = -1;
    return () => {
      if (phase === 0) {
        const response = core.read({ fences: READ_FENCES, key: KEY, lockMs: 1 + Math.floor(random() * 20), refresh: false }, now);
        epochs = response.epochs;
        lockToken = response.kind === "miss" ? response.lockToken : null;
        if (response.kind === "hit") observe(response.value);
        if (lockToken) phase = 1;
        else round++;
      } else if (phase === 1) {
        seen = version;
        phase = 2;
      } else {
        const result = core.write(
          { key: KEY, lockToken: lockToken ?? "", snapshot: epochs, softTtlMs: 1000, ttlMs: 1000, value: String(seen) },
          now,
        );
        if (!result.ok) rejected++;
        phase = 0;
        round++;
      }
      return phase === 0 && round >= rounds;
    };
  }

  const actors: Actor[] = [writer(3), writer(3), reader(12), reader(12), reader(12)];
  const done = actors.map(() => false);
  while (done.includes(false)) {
    const live = done.map((finished, index) => (finished ? -1 : index)).filter((index) => index >= 0);
    const index = live[Math.floor(random() * live.length)] ?? 0;
    done[index] = actors[index]?.() ?? true;
    now += Math.floor(random() * 3);
  }
  return { hits, rejected, violations };
}

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

const summarize = (runs: Array<ReturnType<typeof simulate>>) => ({
  hits: runs.reduce((sum, run) => sum + run.hits, 0),
  rejected: runs.reduce((sum, run) => sum + run.rejected, 0),
  violations: runs.flatMap((run) => run.violations).slice(0, 5),
});

describe("coordinator protocol under random interleavings", () => {
  it("never serves a hit older than the database when every write ends", () => {
    const result = summarize(SEEDS.map((seed) => simulate(seed, { dropEnd: false, leaseMs: (random) => 1 + Math.floor(random() * 30) })));
    expect(result.violations).toEqual([]);
    expect(result.hits).toBeGreaterThan(1000);
    expect(result.rejected).toBeGreaterThan(100);
  });

  it("never serves a hit older than the database when end calls are lost but leases outlive the run", () => {
    const result = summarize(SEEDS.map((seed) => simulate(seed, { dropEnd: true, leaseMs: () => 1_000_000 })));
    expect(result.violations).toEqual([]);
    expect(result.hits).toBeGreaterThan(200);
  });
});
