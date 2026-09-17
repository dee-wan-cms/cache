export interface RelationInfo {
  fieldName: string;
  foreignFields: string[];
  isList: boolean;
  localFields: string[];
  oneToOne: boolean;
  relationName?: string;
  targetModel: string;
}

export interface GeneratedCacheConfig {
  cacheVersion: string;
  cacheableByModel: Record<string, boolean>;
  configFormat: number;
  hasDecimalFields: boolean;
  modelNames: string[];
  primaryKeyFieldsByModel: Record<string, string[]>;
  primaryKeyNameByModel: Record<string, string>;
  relationGraph: Record<string, RelationInfo[]>;
}

export type ReadResponse =
  | { epochs: Record<string, number>; kind: "hit"; refreshToken: null | string; value: string }
  | {
      epochs: Record<string, number>;
      kind: "miss";
      lockHeldForMs: null | number;
      lockToken: null | string;
      pending: boolean;
    };

export interface ReadRequest {
  fences: string[];
  generation?: string;
  key: string;
  lockMs: number;
  refresh: boolean;
}

export interface WriteRequest {
  key: string;
  lockToken: string;
  snapshot: Record<string, number>;
  softTtlMs: number;
  ttlMs: number;
  value: string;
}

export interface ReleaseRequest {
  key: string;
  lockToken: string;
}

export type WriteResult = { ok: true } | { ok: false; reason: "fence" | "full" | "invalid" | "lock" };

export interface BeginWriteRequest {
  fences: string[];
  generation?: string;
  leaseMs: number;
  token: string;
}

export interface EndWriteRequest {
  fences: string[];
  token: string;
}

export interface CacheStore {
  beginWrite(request: BeginWriteRequest): Promise<void>;
  endWrite(request: EndWriteRequest): Promise<void>;
  invalidate(fences: string[]): Promise<void>;
  read(request: ReadRequest): Promise<ReadResponse>;
  release(request: ReleaseRequest): Promise<void>;
  write(request: WriteRequest): Promise<WriteResult>;
}

export interface CacheShape {
  freshTtlSeconds?: number;
  negativeTtlSeconds?: number;
  softTtlRatio?: number;
}

export interface ResolvedShape {
  freshTtlSeconds: number;
  negativeTtlSeconds: number;
  softTtlRatio: number;
}

export interface CacheTestHooks {
  afterBeginWrite?: () => Promise<void>;
  afterFillQuery?: () => Promise<void>;
  skipEndWrite?: () => boolean;
}

export interface DecimalConstructor {
  new (value: string): unknown;
}

export interface CacheExtensionOptions {
  config: GeneratedCacheConfig;
  decimal?: DecimalConstructor;
  enabled?: boolean;
  excludeModels?: string[];
  fillPollDelaysMs?: number[];
  generation?: string;
  leaseMs?: number;
  lockMs?: number;
  maxValueBytes?: number;
  onError?: (error: unknown, context: string) => void;
  scope?: string;
  shape?: { byModel?: Record<string, CacheShape>; default?: CacheShape };
  store: CacheStore;
  /** Test-only fault injection. Never set in production: `skipEndWrite` disables invalidation. */
  unsafeTestHooks?: CacheTestHooks;
  waitUntil?: (promise: Promise<unknown>) => void;
}

export type InvalidationTarget =
  | { all: true }
  | { entities: Array<{ model: string; pk: Array<number | string> }> }
  | { models: string[] };
