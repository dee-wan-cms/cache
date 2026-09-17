import { describe, expect, it } from "vitest";

import { decode, encode, stableStringify } from "../../src/core/codec";

class Decimal {
  readonly d: number[];
  readonly e = 0;
  readonly s = 1;
  constructor(private readonly text: string) {
    this.d = [Number(text)];
  }
  toFixed(): string {
    return this.text;
  }
}

const roundTrip = (value: unknown) => decode(JSON.parse(JSON.stringify(encode(value))), Decimal);

describe("codec", () => {
  it("round-trips Prisma scalar types that JSON loses", () => {
    const value = { at: new Date("2026-09-17T00:00:00.000Z"), big: 12345678901234567890n, bytes: new Uint8Array([0, 255, 7]), price: new Decimal("10.50") };
    const decoded = roundTrip(value);
    expect(decoded).toEqual(value);
    expect(decoded).toMatchObject({ at: expect.any(Date), bytes: expect.any(Uint8Array), price: expect.any(Decimal) });
  });

  it("keeps user JSON that looks like an encoding tag", () => {
    const value = { json: { $t: "d", v: "not a date" }, list: [{ $t: "n", v: "1" }] };
    expect(roundTrip(value)).toEqual(value);
  });

  it("gives distinct keys to argument objects that differ only by class", () => {
    class DbNull {
      toString() {
        return "Prisma.DbNull";
      }
    }
    class JsonNull {
      toString() {
        return "Prisma.JsonNull";
      }
    }
    const dbNull = new DbNull();
    const jsonNull = new JsonNull();
    expect(stableStringify({ where: { meta: dbNull } })).not.toBe(stableStringify({ where: { meta: jsonNull } }));
    expect(stableStringify({ where: { meta: dbNull } })).not.toBe(stableStringify({ where: { meta: {} } }));
  });

  it("keeps own __proto__ keys when hashing and storing", () => {
    const withProto = JSON.parse('{"where":{"meta":{"equals":{"__proto__":{"a":1}}}}}');
    expect(stableStringify(withProto)).not.toBe(stableStringify({ where: { meta: { equals: {} } } }));
    const stored = JSON.parse('{"__proto__":{"x":1},"b":2}');
    const decoded = roundTrip(stored);
    expect(Object.keys(decoded as object)).toEqual(["__proto__", "b"]);
  });

  it("hashes arguments independently of key order", () => {
    expect(stableStringify({ a: 1, b: { c: 2, d: 3 } })).toBe(stableStringify({ b: { d: 3, c: 2 }, a: 1 }));
    expect(stableStringify({ a: 1n })).not.toBe(stableStringify({ a: "1" }));
  });
});
