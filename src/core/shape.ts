import type { CacheExtensionOptions, CacheShape, ResolvedShape } from "./types";

import { MAX_SHAPE_TTL_SECONDS } from "./limits";

export const DEFAULT_SHAPE: ResolvedShape = { freshTtlSeconds: 3600, negativeTtlSeconds: 600, softTtlRatio: 0.8 };

function validate(label: string, shape: CacheShape | undefined): void {
  if (!shape) return;
  for (const field of ["freshTtlSeconds", "negativeTtlSeconds"] as const) {
    const value = shape[field];
    if (value !== undefined && !(Number.isFinite(value) && value > 0 && value <= MAX_SHAPE_TTL_SECONDS)) {
      throw new TypeError(`cache shape ${label}: ${field} must be in (0, ${MAX_SHAPE_TTL_SECONDS}]`);
    }
  }
  const ratio = shape.softTtlRatio;
  if (ratio !== undefined && !(Number.isFinite(ratio) && ratio > 0 && ratio <= 1)) {
    throw new TypeError(`cache shape ${label}: softTtlRatio must be in (0, 1]`);
  }
}

export function validateShapes(shape: CacheExtensionOptions["shape"]): void {
  validate("default", shape?.default);
  for (const [model, value] of Object.entries(shape?.byModel ?? {})) validate(`byModel.${model}`, value);
}

export function resolveShape(shape: CacheExtensionOptions["shape"], model: string): ResolvedShape {
  const pick = <K extends keyof ResolvedShape>(field: K): ResolvedShape[K] =>
    shape?.byModel?.[model]?.[field] ?? shape?.default?.[field] ?? DEFAULT_SHAPE[field];
  return { freshTtlSeconds: pick("freshTtlSeconds"), negativeTtlSeconds: pick("negativeTtlSeconds"), softTtlRatio: pick("softTtlRatio") };
}
