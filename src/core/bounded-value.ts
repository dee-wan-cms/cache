export function boundedValue(value: unknown, maxBytes: number, identity: boolean): boolean {
  let remaining = 10_000;
  let bytes = maxBytes;
  const seen = new Set<object>();
  const count = (text: string): boolean => {
    if (text.length > bytes) return false;
    bytes -= new TextEncoder().encode(text).byteLength;
    return bytes >= 0;
  };
  const check = (part: unknown, depth: number, objectValue: boolean): boolean => {
    if (--remaining < 0 || depth > 24) return false;
    if (part === undefined) return identity || !objectValue;
    if (part === null || typeof part === 'boolean') return true;
    if (typeof part === 'string') return count(part);
    if (typeof part === 'number') return !Object.is(part, -0);
    if (typeof part === 'bigint') return count(part.toString());
    if (typeof part !== 'object' || seen.has(part)) return false;
    if (part instanceof Date) return Number.isFinite(part.getTime());
    if (part instanceof Uint8Array) { bytes -= part.byteLength * 2; return bytes >= 0; }
    const prototype: unknown = Object.getPrototypeOf(part);
    if (!Array.isArray(part) && prototype !== Object.prototype) return false;
    if (Object.getOwnPropertySymbols(part).length > 0) return false;
    if (Array.isArray(part) && part.length > remaining) return false;
    const properties = Object.getOwnPropertyDescriptors(part);
    if (Object.entries(properties).some(([key, descriptor]) => !(Array.isArray(part) && key === 'length') && (!descriptor.enumerable || !('value' in descriptor)))) return false;
    if (Array.isArray(part) && Object.keys(properties).some((key) => key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))) return false;
    seen.add(part);
    const valid = Array.isArray(part)
      ? Array.from({ length: part.length }, (_, index) => Object.hasOwn(part, index) && check(part[index], depth + 1, false)).every(Boolean)
      : Object.entries(properties).every(([key, descriptor]) => count(key) && check(descriptor.value, depth + 1, true));
    seen.delete(part);
    return valid;
  };
  try { return check(value, 0, false); } catch { return false; }
}

