#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import helper from "@prisma/generator-helper";

import { buildCacheConfig, renderCacheConfig } from "./config";

const PACKAGE_NAME = "@dee-wan/cache";

function listOption(value: string | string[] | undefined): string[] {
  const items = Array.isArray(value) ? value : (value ?? "").split(",");
  return items.map((item) => item.trim()).filter((item) => item.length > 0);
}

helper.generatorHandler({
  onGenerate(options) {
    const output = options.generator.output?.value;
    if (!output) throw new Error("cache generator: output is required");
    const config = buildCacheConfig(options.dmmf.datamodel, listOption(options.generator.config.exclude));
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "cache-config.ts"), renderCacheConfig(config, PACKAGE_NAME));
    return Promise.resolve();
  },
  onManifest() {
    return { defaultOutput: "./generated/cache", prettyName: "Dee Wan cache config" };
  },
});
