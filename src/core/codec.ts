import type { DecimalConstructor } from "./types";

const TAG = "$t";

interface DecimalLike {
  d: unknown;
  e: unknown;
  s: unknown;
  toFixed(): string;
}


function isDecimal(value: object): value is DecimalLike {
  return (
    "toFixed" in value &&
    typeof value.toFixed === "function" &&
    "d" in value &&
    Array.isArray(value.d) &&
    "e" in value &&
    typeof value.e === "number" &&
    "s" in value &&
    typeof value.s === "number"
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { configurable: true, enumerable: true, value, writable: true });
}

export function encode(value: unknown): unknown {
  if (value === undefined) return { [TAG]: "u" };
  if (typeof value === "bigint") return { [TAG]: "n", v: value.toString() };
  if (typeof value === "number" && !Number.isFinite(value)) return { [TAG]: "f", v: String(value) };
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return { [TAG]: "d", v: value.toISOString() };
  if (value instanceof Uint8Array) return { [TAG]: "b", v: bytesToBase64(value) };
  if (Array.isArray(value)) return value.map(encode);
  if (isDecimal(value)) return { [TAG]: "m", v: value.toFixed() };
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) setOwn(out, key, encode(inner));
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return { [TAG]: "c", n: String(value), v: out };
  return Object.hasOwn(out, TAG) ? { [TAG]: "o", v: out } : out;
}

export function decode(value: unknown, decimal?: DecimalConstructor): unknown {
  if (Array.isArray(value)) return value.map((item) => decode(item, decimal));
  if (!isRecord(value)) return value;
  const record = value;
  const tag = record[TAG];
  if ((tag === "o" || tag === "c") && isRecord(record.v)) return decodeRecord(record.v, decimal);
  if (tag === "u") return undefined;
  if (typeof tag === "string" && typeof record.v === "string") {
    if (tag === "n") return BigInt(record.v);
    if (tag === "f") return Number(record.v);
    if (tag === "d") return new Date(record.v);
    if (tag === "b") return base64ToBytes(record.v);
    if (tag === "m") return decimal ? new decimal(record.v) : record.v;
  }
  return decodeRecord(record, decimal);
}

function decodeRecord(record: Record<string, unknown>, decimal?: DecimalConstructor): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(record)) {
    const decoded = decode(inner, decimal);
    if (decoded !== undefined) setOwn(out, key, decoded);
  }
  return out;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(encode(value)));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isRecord(value)) return value;
  const record = value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) setOwn(out, key, sortKeys(record[key]));
  return out;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
