import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PACKAGE = resolve(import.meta.dirname, "../..");
const manifest: { allowScripts: Record<string, boolean>; devDependencies: Record<string, string> } = JSON.parse(
  readFileSync(join(PACKAGE, "package.json"), "utf8"),
);
const pinned = (name: string): string => {
  const version = manifest.devDependencies[name];
  if (!version) throw new Error(`devDependency ${name} is not pinned`);
  return version;
};

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
let project = "";

const inheritedPath = (process.env.PATH ?? "")
  .split(delimiter)
  .filter((entry) => !entry.includes(join("node_modules", ".bin")))
  .join(delimiter);

function sh(command: string, args: string[], cwd = project): string {
  const path = cwd === project ? [join(project, "node_modules/.bin"), inheritedPath].join(delimiter) : inheritedPath;
  return execFileSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, CI: "1", PATH: path }, stdio: ["ignore", "pipe", "pipe"] });
}

const SCHEMA = `
generator client {
  provider        = "prisma-client-js"
  output          = "../generated/prisma"
}

generator cache {
  provider = "dee-wan-cache-generator"
  output   = "../generated/cache"
}

datasource db {
  provider = "sqlite"
  url      = "file:./unused.db"
}

model Note {
  id   Int    @id
  body String
}
`;

const WORKER = `
import { PrismaD1 } from "@prisma/adapter-d1";
import { createCacheExtension } from "@dee-wan/cache";
import { createDurableObjectStore, type CacheCoordinator } from "@dee-wan/cache/cloudflare";
import { cacheConfig } from "../generated/cache/cache-config";
import { PrismaClient } from "../generated/prisma";

export { CacheCoordinator } from "@dee-wan/cache/cloudflare";

interface Env {
  CACHE_COORDINATOR: DurableObjectNamespace<CacheCoordinator>;
  DB: D1Database;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let statements = 0;
    const db = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") return (query: string) => (statements++, target.prepare(query));
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const prisma = new PrismaClient({ adapter: new PrismaD1(db) }).$extends(
      createCacheExtension({
        config: cacheConfig,
        generation: "consumer",
        store: createDurableObjectStore(env.CACHE_COORDINATOR, { locationHint: "apac", name: "notes-db" }),
        waitUntil: (promise) => ctx.waitUntil(promise),
      }),
    );
    const url = new URL(request.url);
    const body = url.searchParams.get("body");
    const value = body
      ? await prisma.note.upsert({ create: { body, id: 1 }, update: { body }, where: { id: 1 } })
      : await prisma.note.findUnique({ where: { id: 1 } });
    return Response.json({ statements, value });
  },
} satisfies ExportedHandler<Env>;
`;

beforeAll(() => {
  const require = createRequire(join(PACKAGE, "package.json"));
  sh(process.execPath, [join(dirname(require.resolve("tsup/package.json")), "dist/cli-default.js")], PACKAGE);
  project = mkdtempSync(join(tmpdir(), "dee-wan-cache-consumer-"));
  const packed = sh(npm, ["pack", "--pack-destination", project, "--json"], PACKAGE);
  const tarball: unknown = JSON.parse(packed)[0]?.filename;
  if (typeof tarball !== "string") throw new Error("npm pack returned no tarball");
  const deps = ["@prisma/adapter-d1", "@prisma/client", "prisma", "wrangler", "miniflare", "typescript", "@cloudflare/workers-types"];
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify(
      {
        allowScripts: manifest.allowScripts,
        dependencies: { "@dee-wan/cache": `file:./${tarball}`, ...Object.fromEntries(deps.map((name) => [name, pinned(name)])) },
        name: "cache-consumer",
        private: true,
        type: "module",
      },
      null,
      2,
    ),
  );
  writeFileSync(join(project, ".npmrc"), "strict-allow-scripts=true\n");
  sh(npm, ["install", "--no-audit", "--no-fund"]);
  mkdirSync(join(project, "prisma"));
  mkdirSync(join(project, "src"));
  writeFileSync(join(project, "prisma/schema.prisma"), SCHEMA);
  writeFileSync(join(project, "src/index.ts"), WORKER);
  writeFileSync(
    join(project, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        lib: ["ES2022"],
        module: "ESNext",
        moduleResolution: "bundler",
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: "ES2022",
        types: ["@cloudflare/workers-types"],
      },
      include: ["src", "generated/cache"],
    }),
  );
  writeFileSync(
    join(project, "wrangler.jsonc"),
    JSON.stringify({ compatibility_date: "2025-08-01", main: "src/index.ts", name: "cache-consumer" }),
  );
}, 600_000);

afterAll(() => {
  if (project && !process.env.CONSUMER_KEEP) rmSync(project, { force: true, recursive: true });
});

describe("installed package in a fresh Worker project", () => {
  it("generates, typechecks, bundles and serves fill, hit and invalidation on workerd", async () => {
    expect(existsSync(join(project, "node_modules/.bin/dee-wan-cache-generator"))).toBe(true);
    sh(join(project, "node_modules/.bin/prisma"), ["generate", "--schema", "prisma/schema.prisma"]);
    const config = readFileSync(join(project, "generated/cache/cache-config.ts"), "utf8");
    expect(config).toContain('import type { GeneratedCacheConfig } from "@dee-wan/cache";');
    expect(config).toContain('"Note": true');
    sh(join(project, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"]);
    sh(join(project, "node_modules/.bin/wrangler"), ["deploy", "--dry-run", "--outdir", "dist"]);
    const ddl = sh(join(project, "node_modules/.bin/prisma"), [
      "migrate",
      "diff",
      "--from-empty",
      "--to-schema-datamodel",
      "prisma/schema.prisma",
      "--script",
    ]);
    const { Miniflare } = await import(pathToFileURL(join(project, "node_modules/miniflare/dist/src/index.js")).href);
    const mf = new Miniflare({
      compatibilityDate: "2025-08-01",
      d1Databases: { DB: "consumer-db" },
      durableObjects: { CACHE_COORDINATOR: { className: "CacheCoordinator", useSQLite: true } },
      modules: true,
      modulesRoot: join(project, "dist"),
      modulesRules: [{ include: ["**/*.wasm"], type: "CompiledWasm" }],
      scriptPath: join(project, "dist/index.js"),
    });
    try {
      const db = await mf.getD1Database("DB");
      for (const statement of ddl.split(/;\s*\n/).map((part) => part.replace(/^--.*$/gm, "").trim()).filter(Boolean)) {
        await db.prepare(statement).run();
      }
      const call = async (query = "") => {
        const response = await mf.dispatchFetch(`http://consumer/${query}`);
        return JSON.parse(await response.text());
      };
      await call("?body=first");
      const cold = await call();
      const hit = await call();
      await call("?body=second");
      const fresh = await call();
      expect(cold).toMatchObject({ value: { body: "first" } });
      expect(cold.statements).toBeGreaterThan(0);
      expect(hit).toEqual({ statements: 0, value: { body: "first", id: 1 } });
      expect(fresh).toMatchObject({ value: { body: "second" } });
    } finally {
      await mf.dispose();
    }
  }, 300_000);
});
