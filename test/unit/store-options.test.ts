import { describe, expect, it } from "vitest";

import { decode, encode } from "../../src/core/codec";
import { resolveStoreOptions } from "../../src/cloudflare/store-options";

describe("store options", () => {
  it("requires a coordinator name so databases never share entries by default", () => {
    expect(() => resolveStoreOptions(JSON.parse("{}"))).toThrow(/name must be/);
    expect(() => resolveStoreOptions({ name: "" })).toThrow(/name must be/);
    expect(resolveStoreOptions({ name: "db-1" })).toMatchObject({ attempts: 3, name: "db-1" });
  });

  it("validates attempts and location hints", () => {
    expect(() => resolveStoreOptions({ attempts: 0, name: "db" })).toThrow(/attempts/);
    expect(() => resolveStoreOptions({ locationHint: JSON.parse('"mars"'), name: "db" })).toThrow(/locationHint/);
    expect(resolveStoreOptions({ locationHint: "weur", name: "db" }).locationHint).toBe("weur");
  });
});

describe("non-finite numbers", () => {
  it("survive storage instead of turning into null", () => {
    const value = { a: Number.NaN, b: Number.POSITIVE_INFINITY, c: Number.NEGATIVE_INFINITY, d: 1.5 };
    expect(decode(JSON.parse(JSON.stringify(encode(value))))).toEqual(value);
  });
});
