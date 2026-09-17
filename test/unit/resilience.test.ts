import { describe, expect, it } from "vitest";

import type { CacheStore, GeneratedCacheConfig } from "../../src/core/types";

import { isRetryable, retryTransient } from "../../src/cloudflare/retry";
import { createCacheExtension } from "../../src/core/extension";
import { CONFIG_FORMAT } from "../../src/core/limits";
import { rawWritePlanFences } from "../../src/core/plan";

const transient = (overloaded = false) => Object.assign(new Error("transient"), { overloaded, retryable: true });

describe("write-path retries", () => {
  it("retries retryable errors with a fresh call and backoff, up to the attempt limit", async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await retryTransient(
      async () => {
        calls++;
        if (calls < 3) throw transient();
        return "ok";
      },
      3,
      async (ms) => void delays.push(ms),
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(delays).toHaveLength(2);
    await expect(retryTransient(() => Promise.reject(transient()), 2, async () => undefined)).rejects.toThrow("transient");
  });

  it("does not retry overloaded or non-retryable errors", async () => {
    expect(isRetryable(transient(true))).toBe(false);
    expect(isRetryable(new Error("plain"))).toBe(false);
    let calls = 0;
    await expect(
      retryTransient(
        () => {
          calls++;
          return Promise.reject(transient(true));
        },
        5,
        async () => undefined,
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

const config: GeneratedCacheConfig = {
  cacheVersion: "t",
  cacheableByModel: { Post: true, User: true },
  configFormat: CONFIG_FORMAT,
  hasDecimalFields: false,
  primaryKeyNameByModel: {},
  modelNames: ["User", "Post"],
  primaryKeyFieldsByModel: { Post: ["id"], User: ["id"] },
  relationGraph: { Post: [{ fieldName: "author", foreignFields: ["id"], localFields: ["authorId"], isList: false, oneToOne: false, targetModel: "User" }] },
};

const unusedStore: CacheStore = {
  beginWrite: () => Promise.reject(new Error("unused")),
  endWrite: () => Promise.reject(new Error("unused")),
  invalidate: () => Promise.reject(new Error("unused")),
  read: () => Promise.reject(new Error("unused")),
  release: () => Promise.reject(new Error("unused")),
  write: () => Promise.reject(new Error("unused")),
};

describe("option validation", () => {
  it.each([
    [{ lockMs: 0 }, /lockMs/],
    [{ lockMs: 10_000_000 }, /lockMs/],
    [{ leaseMs: Number.NaN }, /leaseMs/],
    [{ maxValueBytes: 3_000_000 }, /maxValueBytes/],
    [{ fillPollDelaysMs: [-1] }, /fillPollDelaysMs/],
    [{ excludeModels: ["Missing"] }, /unknown model/],
    [{ shape: { default: { softTtlRatio: 2 } } }, /softTtlRatio/],
  ])("rejects %j", (bad, message) => {
    expect(() => createCacheExtension({ config, store: unusedStore, ...bad })).toThrow(message);
  });

  it("accepts defaults", () => {
    expect(createCacheExtension({ config, store: unusedStore }).name).toBe("dee-wan-cache");
  });
});

describe("raw write targets", () => {
  it("widens models that reference the written model and rejects unknown names", () => {
    expect(rawWritePlanFences(config, { models: ["User"] }).sort()).toEqual(["m:Post", "m:User", "w:Post", "w:User"]);
    expect(rawWritePlanFences(config, { entities: [{ model: "User", pk: [1] }] }).sort()).toEqual(["e:User:1", "m:Post", "w:Post", "w:User"]);
    expect(rawWritePlanFences(config, { entities: [{ model: "Post", pk: [1, 2] }] }).sort()).toEqual(["m:Post", "w:Post"]);
    expect(rawWritePlanFences(config, { all: true })).toEqual(["g"]);
    expect(() => rawWritePlanFences(config, { models: ["Usr"] })).toThrow(/unknown models Usr/);
  });
});
