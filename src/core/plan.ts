import type { GeneratedCacheConfig, InvalidationTarget, RelationInfo } from "./types";

import { entityFence, GLOBAL_FENCE, modelFence, writeFence } from "./fences";
import { isPlainRecord, pkFromRow, pkFromWhere } from "./pk";

export const MAX_NESTED_WRITE_DEPTH = 5;
export const MAX_ENTITY_FENCES_PER_MODEL = 100;

export const READ_OPERATIONS = new Set(["count", "findFirst", "findFirstOrThrow", "findMany", "findUnique", "findUniqueOrThrow"]);

export const WRITE_OPERATIONS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "delete",
  "deleteMany",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
]);

interface ModelTouch {
  pks: Set<string>;
  wide: boolean;
}

export interface WritePlan {
  all: boolean;
  touched: Map<string, ModelTouch>;
}

interface PlanContext {
  config: GeneratedCacheConfig;
  plan: WritePlan;
}

const pkFieldsOf = (config: GeneratedCacheConfig, model: string): string[] => config.primaryKeyFieldsByModel[model] ?? ["id"];

function touch(plan: WritePlan, model: string): ModelTouch {
  const existing = plan.touched.get(model);
  if (existing) return existing;
  const created: ModelTouch = { pks: new Set(), wide: false };
  plan.touched.set(model, created);
  return created;
}

const touchWrite = (ctx: PlanContext, model: string): void => void touch(ctx.plan, model);

const touchWide = (ctx: PlanContext, model: string): void => void (touch(ctx.plan, model).wide = true);

function touchEntity(ctx: PlanContext, model: string, where: unknown): void {
  const pk = pkFromWhere(where, pkFieldsOf(ctx.config, model), ctx.config.primaryKeyNameByModel[model]);
  if (pk === null) touchWide(ctx, model);
  else touch(ctx.plan, model).pks.add(pk);
}

function referencedFields(config: GeneratedCacheConfig, model: string): Set<string> {
  const fields = new Set<string>();
  for (const relations of Object.values(config.relationGraph)) {
    for (const relation of relations) {
      if (relation.targetModel === model && relation.localFields.length > 0) {
        for (const field of relation.foreignFields) fields.add(field);
      }
    }
  }
  return fields;
}

function touchReferencing(ctx: PlanContext, model: string, seen = new Set<string>()): void {
  if (seen.has(model)) return;
  seen.add(model);
  for (const [owner, relations] of Object.entries(ctx.config.relationGraph)) {
    const references = relations.some((relation) => relation.targetModel === model && relation.localFields.length > 0);
    if (!references) continue;
    touchWide(ctx, owner);
    touchReferencing(ctx, owner, seen);
  }
}

function touchReferencingIfKeyChanges(ctx: PlanContext, model: string, data: unknown): void {
  if (!isPlainRecord(data)) return;
  const referenced = referencedFields(ctx.config, model);
  if (Object.keys(data).some((field) => referenced.has(field))) touchReferencing(ctx, model);
}

const asItems = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);

const ONE_TO_ONE_REPARENTING_OPS = new Set(["connect", "connectOrCreate", "create", "upsert"]);

const FOREIGN_KEY_CHANGING_OPS = new Set(["connect", "connectOrCreate", "create", "delete", "disconnect", "set", "upsert"]);

const overlaps = (fields: string[], referenced: Set<string>): boolean => fields.some((field) => referenced.has(field));

function widenIfForeignKeyReferenced(ctx: PlanContext, model: string, relation: RelationInfo): void {
  if (overlaps(relation.localFields, referencedFields(ctx.config, model))) touchReferencing(ctx, model);
  const opposite = (ctx.config.relationGraph[relation.targetModel] ?? []).find(
    (candidate) => candidate !== relation && candidate.relationName !== undefined && candidate.relationName === relation.relationName,
  );
  if (opposite && overlaps(opposite.localFields, referencedFields(ctx.config, relation.targetModel))) {
    touchReferencing(ctx, relation.targetModel);
  }
}

function nestedWrites(ctx: PlanContext, model: string, data: unknown, depth: number): void {
  if (!isPlainRecord(data)) return;
  for (const relation of ctx.config.relationGraph[model] ?? []) {
    const ops = data[relation.fieldName];
    if (!isPlainRecord(ops)) continue;
    const target = relation.targetModel;
    if (depth >= MAX_NESTED_WRITE_DEPTH) {
      ctx.plan.all = true;
      return;
    }
    touchWrite(ctx, target);
    const recurse = (value: unknown) => nestedWrites(ctx, target, value, depth + 1);
    for (const [op, value] of Object.entries(ops)) {
      const items = asItems(value);
      if (relation.oneToOne === true && ONE_TO_ONE_REPARENTING_OPS.has(op)) {
        touchWide(ctx, target);
        touchWide(ctx, model);
      }
      if (FOREIGN_KEY_CHANGING_OPS.has(op)) widenIfForeignKeyReferenced(ctx, model, relation);
      switch (op) {
        case "create":
          items.forEach(recurse);
          break;
        case "createMany":
          break;
        case "connect":
          items.forEach((item) => touchEntity(ctx, target, item));
          break;
        case "connectOrCreate":
          for (const item of items) {
            touchEntity(ctx, target, isPlainRecord(item) ? item.where : undefined);
            if (isPlainRecord(item)) recurse(item.create);
          }
          break;
        case "disconnect":
          items.forEach((item) => (isPlainRecord(item) ? touchEntity(ctx, target, item) : touchWide(ctx, target)));
          break;
        case "delete":
          items.forEach((item) => (isPlainRecord(item) ? touchEntity(ctx, target, item) : touchWide(ctx, target)));
          touchReferencing(ctx, target);
          break;
        case "deleteMany":
          touchWide(ctx, target);
          touchReferencing(ctx, target);
          break;
        case "update":
        case "upsert":
          for (const item of items) {
            const hasWhere = isPlainRecord(item) && "where" in item;
            if (hasWhere) touchEntity(ctx, target, item.where);
            else touchWide(ctx, target);
            const payloads = isPlainRecord(item) ? [item.data, item.create, item.update, hasWhere ? undefined : item] : [];
            for (const payload of payloads) {
              touchReferencingIfKeyChanges(ctx, target, payload);
              recurse(payload);
            }
          }
          break;
        default:
          touchWide(ctx, target);
          for (const item of items) if (isPlainRecord(item)) touchReferencingIfKeyChanges(ctx, target, item.data);
      }
    }
  }
}

export function planWrite(config: GeneratedCacheConfig, model: string, operation: string, args: unknown): WritePlan {
  const ctx: PlanContext = { config, plan: { all: false, touched: new Map() } };
  const input = isPlainRecord(args) ? args : {};
  touchWrite(ctx, model);
  switch (operation) {
    case "create":
      nestedWrites(ctx, model, input.data, 0);
      break;
    case "createMany":
    case "createManyAndReturn":
      break;
    case "update":
      touchEntity(ctx, model, input.where);
      touchReferencingIfKeyChanges(ctx, model, input.data);
      nestedWrites(ctx, model, input.data, 0);
      break;
    case "upsert":
      touchEntity(ctx, model, input.where);
      touchReferencingIfKeyChanges(ctx, model, input.update);
      nestedWrites(ctx, model, input.create, 0);
      nestedWrites(ctx, model, input.update, 0);
      break;
    case "delete":
      touchEntity(ctx, model, input.where);
      touchReferencing(ctx, model);
      break;
    case "deleteMany":
      touchWide(ctx, model);
      touchReferencing(ctx, model);
      break;
    default:
      touchWide(ctx, model);
      touchReferencingIfKeyChanges(ctx, model, input.data);
  }
  return ctx.plan;
}

export function planFences(plan: WritePlan): string[] {
  if (plan.all) return [GLOBAL_FENCE];
  const fences: string[] = [];
  for (const [model, { pks, wide }] of plan.touched) {
    fences.push(writeFence(model));
    if (wide || pks.size > MAX_ENTITY_FENCES_PER_MODEL) fences.push(modelFence(model));
    else for (const pk of pks) fences.push(entityFence(model, pk));
  }
  return fences;
}

export function rawWritePlanFences(config: GeneratedCacheConfig, target: InvalidationTarget): string[] {
  if ("all" in target) return [GLOBAL_FENCE];
  const ctx: PlanContext = { config, plan: { all: false, touched: new Map() } };
  const known = new Set(config.modelNames);
  const models = "models" in target ? target.models : target.entities.map(({ model }) => model);
  const unknown = models.filter((model) => !known.has(model));
  if (unknown.length > 0) throw new TypeError(`cache invalidation: unknown models ${unknown.join(", ")}`);
  if ("models" in target) target.models.forEach((model) => touchWide(ctx, model));
  else {
    for (const { model, pk } of target.entities) {
      const fields = pkFieldsOf(config, model);
      const encoded = pk.length === fields.length ? pkFromRow(Object.fromEntries(fields.map((field, i) => [field, pk[i]])), fields) : null;
      if (encoded === null) touchWide(ctx, model);
      else touch(ctx.plan, model).pks.add(encoded);
    }
  }
  models.forEach((model) => touchReferencing(ctx, model));
  return planFences(ctx.plan);
}
