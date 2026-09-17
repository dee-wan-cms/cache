import type { RelationInfo } from "./types";

import { isPlainRecord } from "./pk";

export const MAX_RELATION_DEPTH = 10;

const RELATION_FILTER_KEYS = ["some", "every", "none", "is", "isNot"];
const LOGICAL_KEYS = new Set(["AND", "OR", "NOT"]);

type Graph = Record<string, RelationInfo[]>;

export interface ReadTargets {
  models: Set<string>;
  relational: boolean;
}

interface Walk {
  graph: Graph;
  out: ReadTargets;
}

function relationsOf(graph: Graph, model: string): Map<string, RelationInfo> {
  return new Map((graph[model] ?? []).map((relation) => [relation.fieldName, relation]));
}

function reach(walk: Walk, relation: RelationInfo): void {
  walk.out.models.add(relation.targetModel);
  walk.out.relational = true;
}

function walkFilter(walk: Walk, model: string, value: unknown, depth: number): boolean {
  if (depth > MAX_RELATION_DEPTH) return false;
  if (Array.isArray(value)) return value.every((item) => walkFilter(walk, model, item, depth + 1));
  if (!isPlainRecord(value)) return true;
  const relations = relationsOf(walk.graph, model);
  for (const [key, nested] of Object.entries(value)) {
    if (LOGICAL_KEYS.has(key)) {
      if (!walkFilter(walk, model, nested, depth + 1)) return false;
      continue;
    }
    const relation = relations.get(key);
    if (!relation) continue;
    reach(walk, relation);
    if (!isPlainRecord(nested)) continue;
    const wrapped = RELATION_FILTER_KEYS.filter((wrapper) => wrapper in nested);
    const inner = wrapped.length > 0 ? wrapped.map((wrapper) => nested[wrapper]) : [nested];
    if (!inner.every((item) => walkFilter(walk, relation.targetModel, item, depth + 1))) return false;
  }
  return true;
}

function walkCount(walk: Walk, model: string, count: unknown, depth: number): boolean {
  if (count === undefined) return true;
  const select = isPlainRecord(count) && isPlainRecord(count.select) ? count.select : null;
  for (const relation of walk.graph[model] ?? []) {
    const selected = select ? select[relation.fieldName] : count;
    if (!selected) continue;
    reach(walk, relation);
    if (isPlainRecord(selected) && !walkFilter(walk, relation.targetModel, selected.where, depth + 1)) return false;
  }
  return true;
}

function walkArgs(walk: Walk, model: string, args: unknown, depth: number): boolean {
  walk.out.models.add(model);
  if (!isPlainRecord(args)) return true;
  for (const filter of [args.where, args.orderBy, args.cursor]) {
    if (!walkFilter(walk, model, filter, depth)) return false;
  }
  for (const projection of [args.include, args.select]) {
    if (!isPlainRecord(projection)) continue;
    if (!walkCount(walk, model, projection._count, depth)) return false;
    for (const relation of walk.graph[model] ?? []) {
      const nested = projection[relation.fieldName];
      if (!nested) continue;
      reach(walk, relation);
      if (!walkArgs(walk, relation.targetModel, nested, depth + 1)) return false;
    }
  }
  return true;
}

export function readTargets(graph: Graph, model: string, args: unknown): null | ReadTargets {
  const walk: Walk = { graph, out: { models: new Set(), relational: false } };
  return walkArgs(walk, model, args, 0) ? walk.out : null;
}
