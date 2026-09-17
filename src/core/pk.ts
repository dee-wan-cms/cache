export type PkValue = number | string;

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function encodePk(parts: ReadonlyArray<PkValue>): string {
  return parts.map((part) => encodeURIComponent(String(part))).join(":");
}

function unwrapEquals(value: unknown): unknown {
  return isPlainRecord(value) && "equals" in value ? value.equals : value;
}

function isScalarPk(value: unknown): value is PkValue {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

export function pkFromWhere(where: unknown, pkFields: string[], compoundName?: string): null | string {
  if (!isPlainRecord(where)) return null;
  const compound = where[compoundName ?? pkFields.join("_")];
  const source = pkFields.length > 1 && isPlainRecord(compound) ? compound : where;
  const parts: PkValue[] = [];
  for (const field of pkFields) {
    const value = source === where ? unwrapEquals(where[field]) : source[field];
    if (!isScalarPk(value)) return null;
    parts.push(value);
  }
  return encodePk(parts);
}

export function pkFromRow(row: unknown, pkFields: string[]): null | string {
  if (!isPlainRecord(row)) return null;
  const parts: PkValue[] = [];
  for (const field of pkFields) {
    const value = row[field];
    if (!isScalarPk(value)) return null;
    parts.push(value);
  }
  return encodePk(parts);
}
