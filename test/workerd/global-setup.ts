import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

const PACKAGE = resolve(import.meta.dirname, "../..");
const WORKERD = join(PACKAGE, "test/workerd");
const require = createRequire(join(PACKAGE, "package.json"));

const bin = (pkg: string, relative: string): string => join(dirname(require.resolve(`${pkg}/package.json`)), relative);

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(process.execPath, [command, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export default function setup(): void {
  rmSync(join(PACKAGE, "dist"), { force: true, recursive: true });
  run(bin("tsup", "dist/cli-default.js"), [], PACKAGE);
  const prisma = bin("prisma", "build/index.js");
  run(prisma, ["generate", "--schema", "prisma/schema.prisma"], WORKERD);
  const ddl = run(prisma, ["migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/schema.prisma", "--script"], WORKERD);
  mkdirSync(join(WORKERD, ".build"), { recursive: true });
  writeFileSync(join(WORKERD, ".build/schema.sql"), ddl);
  const wrangler = bin("wrangler", "bin/wrangler.js");
  for (const name of ["a", "b"]) {
    run(wrangler, ["deploy", "--dry-run", "-c", `wrangler.${name}.jsonc`, "--outdir", `.build/${name}`], WORKERD);
  }
}
