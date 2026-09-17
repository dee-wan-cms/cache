import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

const PACKAGE = resolve(import.meta.dirname, "../..");
const require = createRequire(join(PACKAGE, "package.json"));
const bin = (pkg: string, relative: string) => join(dirname(require.resolve(`${pkg}/package.json`)), relative);

const schema = (generator: string) => `
generator cache {
  provider = "node ${join(PACKAGE, "dist/generator/index.js")}"
  output   = "./out"
${generator}
}

datasource db {
  provider = "sqlite"
  url      = "file:./unused.db"
}

model Author {
  id      Int      @id
  balance Decimal?
  books   Book[]
  profile Profile?
}

model Profile {
  id       Int    @id
  authorId Int    @unique
  author   Author @relation(fields: [authorId], references: [id])
}

model Tagline {
  text String @unique
}

model Edition {
  isbn   String
  number Int
  @@id(name: "editionKey", fields: [isbn, number])
}

/// @cache.skip
model Book {
  isbn     String
  edition  Int
  authorId Int
  author   Author @relation(fields: [authorId], references: [id])
  @@id([isbn, edition])
}

model Review {
  id   Int    @id
  body String
}
`;

function generate(generator: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cache-generator-"));
  writeFileSync(join(dir, "schema.prisma"), schema(generator));
  execFileSync(process.execPath, [bin("prisma", "build/index.js"), "generate", "--schema", "schema.prisma"], { cwd: dir, stdio: "pipe" });
  return readFileSync(join(dir, "out/cache-config.ts"), "utf8");
}

describe("cache config generator under prisma generate", () => {
  beforeAll(() => {
    execFileSync(process.execPath, [bin("tsup", "dist/cli-default.js")], { cwd: PACKAGE, stdio: "pipe" });
  });

  it("marks every model cacheable except schema opt-outs, with compound keys and relations", () => {
    const source = generate("");
    const config = JSON.parse(source.slice(source.indexOf("= ") + 2, source.lastIndexOf(";")));
    expect(config.cacheableByModel).toEqual({ Author: true, Book: false, Edition: true, Profile: true, Review: true, Tagline: true });
    expect(config.primaryKeyFieldsByModel.Book).toEqual(["isbn", "edition"]);
    expect(config.relationGraph.Book).toEqual([
      { fieldName: "author", foreignFields: ["id"], isList: false, localFields: ["authorId"], oneToOne: false, relationName: "AuthorToBook", targetModel: "Author" },
    ]);
    expect(config.relationGraph.Author).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fieldName: "books", isList: true, oneToOne: false }),
        expect.objectContaining({ fieldName: "profile", isList: false, oneToOne: true }),
      ]),
    );
    expect(config.relationGraph.Profile).toEqual([expect.objectContaining({ fieldName: "author", oneToOne: true })]);
    expect(config.primaryKeyFieldsByModel.Tagline).toEqual(["text"]);
    expect(config.primaryKeyNameByModel).toEqual({ Edition: "editionKey" });
    expect(config.hasDecimalFields).toBe(true);
    expect(source).toContain('import type { GeneratedCacheConfig } from "@dee-wan/cache";');
  });

  it("accepts a generator-level exclude list and rejects unknown names", () => {
    const source = generate('  exclude  = ["Review"]');
    expect(source).toContain('"Review": false');
    expect(() => generate('  exclude  = ["Missing"]')).toThrow(/unknown models in exclude: Missing/);
  });
});
