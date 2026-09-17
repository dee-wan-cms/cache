import { createHash } from "node:crypto";

import type { DMMF } from "@prisma/generator-helper";

import type { GeneratedCacheConfig, RelationInfo } from "../core/types";

import { CONFIG_FORMAT } from "../core/limits";

export const CACHE_CONFIG_SALT = "cf-1";
export const SKIP_DIRECTIVE = "@cache.skip";

type Model = DMMF.Datamodel["models"][number];

function relationsOf(model: Model, models: readonly Model[]): RelationInfo[] {
  return model.fields
    .filter((field) => field.kind === "object")
    .map((field) => {
      const opposite = models
        .find((candidate) => candidate.name === field.type)
        ?.fields.find((other) => other.kind === "object" && other.relationName === field.relationName && other !== field);
      return {
        fieldName: field.name,
        foreignFields: [...(field.relationToFields ?? [])],
        isList: field.isList,
        localFields: [...(field.relationFromFields ?? [])],
        oneToOne: !field.isList && opposite !== undefined && !opposite.isList,
        ...(field.relationName ? { relationName: field.relationName } : {}),
        targetModel: field.type,
      };
    });
}

interface PrimaryKey {
  fields: string[];
  name?: string;
}

function primaryKeyOf(model: Model): PrimaryKey {
  const idFields = model.fields.filter((field) => field.isId).map((field) => field.name);
  if (idFields.length > 0) return { fields: idFields };
  if (model.primaryKey) return { fields: [...model.primaryKey.fields], ...(model.primaryKey.name ? { name: model.primaryKey.name } : {}) };
  const uniqueIndex = model.uniqueIndexes[0];
  if (uniqueIndex) return { fields: [...uniqueIndex.fields], ...(uniqueIndex.name ? { name: uniqueIndex.name } : {}) };
  const uniqueField = model.fields.find((field) => field.isUnique);
  if (uniqueField) return { fields: [uniqueField.name] };
  throw new Error(`cache generator: model ${model.name} has no primary key or unique constraint`);
}

export const isSkipped = (model: Model): boolean =>
  (model.documentation ?? "").split(/\r?\n/).some((line) => line.trim() === SKIP_DIRECTIVE);

export function buildCacheConfig(datamodel: DMMF.Datamodel, excludeModels: string[] = []): GeneratedCacheConfig {
  const excluded = new Set(excludeModels);
  const unknown = excludeModels.filter((name) => !datamodel.models.some((model) => model.name === name));
  if (unknown.length > 0) throw new Error(`cache generator: unknown models in exclude: ${unknown.join(", ")}`);
  const cacheVersion = createHash("sha256")
    .update(JSON.stringify(datamodel) + CACHE_CONFIG_SALT)
    .digest("hex")
    .slice(0, 12);
  const keys = datamodel.models.map((model) => [model.name, primaryKeyOf(model)] as const);
  const named = keys.flatMap(([name, key]) => (key.name ? [[name, key.name] as const] : []));
  return {
    cacheVersion,
    configFormat: CONFIG_FORMAT,
    cacheableByModel: Object.fromEntries(datamodel.models.map((model) => [model.name, !isSkipped(model) && !excluded.has(model.name)])),
    hasDecimalFields: datamodel.models.some((model) => model.fields.some((field) => field.type === "Decimal")),
    modelNames: datamodel.models.map((model) => model.name),
    primaryKeyFieldsByModel: Object.fromEntries(keys.map(([name, key]) => [name, key.fields])),
    primaryKeyNameByModel: Object.fromEntries(named),
    relationGraph: Object.fromEntries(
      datamodel.models
        .map((model) => [model.name, relationsOf(model, datamodel.models)] as const)
        .filter(([, relations]) => relations.length > 0),
    ),
  };
}

export function renderCacheConfig(config: GeneratedCacheConfig, importFrom: string): string {
  return `import type { GeneratedCacheConfig } from "${importFrom}";

export const cacheConfig: GeneratedCacheConfig = ${JSON.stringify(config, null, 2)};
`;
}
