import { DatabaseSync } from "node:sqlite";

import type { Row, SqlLike, SqlValue, Transact } from "../../src/cloudflare/coordinator-core";

const toSqlValue = (value: unknown): SqlValue =>
  value === null || typeof value === "number" || typeof value === "string" ? value : typeof value === "bigint" ? Number(value) : String(value);

export interface TestSql extends SqlLike {
  all(query: string, ...bindings: SqlValue[]): Row[];
  transact: Transact;
}

export function memorySql(): TestSql {
  const db = new DatabaseSync(":memory:");
  const all = (query: string, ...bindings: SqlValue[]): Row[] => {
    const statements = query.split(";").filter((part) => part.trim().length > 0);
    if (bindings.length === 0 && statements.length > 1) {
      db.exec(query);
      return [];
    }
    const params = bindings.map((binding) => (binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding));
    return db
      .prepare(query)
      .all(...params)
      .map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, toSqlValue(value)])));
  };
  const transact: Transact = (run) => {
    db.exec("BEGIN");
    try {
      const result = run();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  return {
    all,
    exec: (query, ...bindings) => {
      const result = all(query, ...bindings);
      return { toArray: () => result };
    },
    transact,
  };
}
