import { CacheUnavailableError } from '../core/extension';
import type { CacheStore } from '../core/types';
import type { D1WritePolicy } from './profile';
import type { D1Database, D1DatabaseSession, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import { boundedD1Store } from './bounded-store';

const fence = ['g'];

const lexemes = /\s+|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:[^']|'')*'?|`(?:[^`]|``)*`?|"(?:[^"]|"")*"?|\[[^\]]*\]?|[A-Za-z_][A-Za-z0-9_$]*|[\s\S]/g;
const safePragmas = new Set(['database_list', 'table_list', 'table_info', 'table_xinfo', 'index_list', 'index_info', 'index_xinfo', 'foreign_key_list']);

function operationOf(tokens: string[], start = 0): string | undefined {
  const word = (index: number) => tokens[index]?.toLowerCase();
  if (word(start) !== 'with') return word(start);
  let index = start + 1;
  if (word(index) === 'recursive') index++;
  const group = (): boolean => {
    if (tokens[index] !== '(') return false;
    let depth = 0;
    do {
      if (tokens[index] === '(') depth++;
      if (tokens[index] === ')') depth--;
      index++;
    } while (index < tokens.length && depth > 0);
    return depth === 0;
  };
  while (index < tokens.length) {
    if (!/^(?:[A-Za-z_][A-Za-z0-9_$]*|`[^`]+`|"[^"]+"|\[[^\]]+\])$/.test(tokens[index] ?? '')) return undefined;
    index++;
    if (tokens[index] === '(' && !group()) return undefined;
    if (word(index++) !== 'as') return undefined;
    if (word(index) === 'not') index++;
    if (word(index) === 'materialized') index++;
    if (tokens[index] !== '(' || !['select', 'with'].includes(word(index + 1) ?? '')) return undefined;
    if (!group()) return undefined;
    if (tokens[index] !== ',') return word(index);
    index++;
  }
  return undefined;
}

function isReadonly(sql: string): boolean {
  const tokens = [...sql.matchAll(lexemes)].map(([token = '']) => token).filter((token) => !/^(?:\s|--|\/\*)/.test(token));
  if (tokens.at(-1) === ';') tokens.pop();
  const first = tokens[0]?.toLowerCase();
  const pragmaName = first === 'pragma' ? (tokens[2] === '.' ? tokens[3] : tokens[1])?.toLowerCase() : undefined;
  const readonlyPragma = first === 'pragma' && pragmaName !== undefined && safePragmas.has(pragmaName) && !tokens.includes('=');
  return !tokens.includes(';') && (operationOf(tokens) === 'select' || readonlyPragma);
}

function needsWriteFence(sql: string, unrelatedWrites: ReadonlySet<string>): boolean {
  const tokens = [...sql.matchAll(lexemes)].map(([token = '']) => token).filter((token) => !/^(?:\s|--|\/\*)/.test(token));
  if (tokens.at(-1) === ';') tokens.pop();
  if (tokens.includes(';')) return true;
  let index = 0;
  const word = () => tokens[index]?.toLowerCase();
  const operation = word();
  if (operation !== 'insert' && operation !== 'update' && operation !== 'delete') return true;
  index++;
  if ((operation === 'insert' || operation === 'update') && word() === 'or') {
    index++;
    if (!['rollback', 'abort', 'replace', 'fail', 'ignore'].includes(word() ?? '')) return true;
    index++;
  }
  if (operation === 'insert') { if (word() !== 'into') return true; index++; }
  if (operation === 'delete') { if (word() !== 'from') return true; index++; }
  const identifier = (token: string | undefined): string | null => {
    if (!token) return null;
    if (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(token)) return token.toLowerCase();
    if (/^"[A-Za-z_][A-Za-z0-9_$]*"$/.test(token) || /^`[A-Za-z_][A-Za-z0-9_$]*`$/.test(token) || /^\[[A-Za-z_][A-Za-z0-9_$]*\]$/.test(token)) return token.slice(1, -1).toLowerCase();
    return null;
  };
  let target = identifier(tokens[index++]);
  if (tokens[index] === '.') {
    if (target !== 'main') return true;
    index++;
    target = identifier(tokens[index++]);
  }
  if (!target || !unrelatedWrites.has(target)) return true;
  if (operation === 'update' && word() !== 'set') return true;
  if (operation === 'delete' && !['where', 'returning'].includes(word() ?? '') && index !== tokens.length) return true;
  return false;
}

export function fenceD1Writes(db: D1Database, options: { store: CacheStore; generation: string; policy: D1WritePolicy }): D1Database {
  const { generation, policy } = options;
  const store = boundedD1Store(options.store);
  const unrelatedWrites = new Set(policy.unfencedWriteTables.map((name) => name.toLowerCase()));
  if (!generation) throw new TypeError('cache generation is required');
  const statements = new WeakMap<D1PreparedStatement, { raw: D1PreparedStatement; fence: boolean }>();
  const withWrite = async <T>(operation: () => Promise<T>): Promise<T> => {
    const token = crypto.randomUUID();
    try {
      await store.beginWrite({ fences: fence, generation, leaseMs: 600000, token });
    } catch (error) {
      await store.endWrite({ fences: fence, token }).catch(() => undefined);
      throw new CacheUnavailableError(error);
    }
    try { return await operation(); }
    finally { await store.endWrite({ fences: fence, token }).catch(() => undefined); }
  };
  const wrapStatement = (raw: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const requiresFence = !isReadonly(sql) && needsWriteFence(sql, unrelatedWrites);
    const execute = <T>(operation: () => Promise<T>): Promise<T> => requiresFence ? withWrite(operation) : operation();
    function rawRows<T = unknown[]>(rawOptions: { columnNames: true }): Promise<[string[], ...T[]]>;
    function rawRows<T = unknown[]>(rawOptions?: { columnNames?: false }): Promise<T[]>;
    function rawRows<T = unknown[]>(rawOptions?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
      return execute<T[] | [string[], ...T[]]>(() => rawOptions?.columnNames === true ? raw.raw<T>({ columnNames: true }) : raw.raw<T>(rawOptions?.columnNames === false ? { columnNames: false } : undefined));
    }
    const wrapped: D1PreparedStatement = {
      bind: (...next) => wrapStatement(raw.bind(...next), sql),
      first: <T = Record<string, unknown>>(column?: string): Promise<T | null> => execute(() => column === undefined ? raw.first<T>() : raw.first<T>(column)),
      all: <T = Record<string, unknown>>(): Promise<D1Result<T>> => execute(() => raw.all<T>()),
      run: <T = Record<string, unknown>>(): Promise<D1Result<T>> => execute(() => raw.run<T>()),
      raw: rawRows,
    };
    statements.set(wrapped, { raw, fence: requiresFence });
    return wrapped;
  };
  const batch = <T>(target: D1Database | D1DatabaseSession, items: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
    const resolved = items.map((item) => statements.get(item));
    const raw = items.map((item, index) => resolved[index]?.raw ?? item);
    const operation = () => target.batch<T>(raw);
    return resolved.every((item) => item !== undefined && !item.fence) ? operation() : withWrite(operation);
  };
  return {
    prepare: (sql) => wrapStatement(db.prepare(sql), sql),
    batch: <T = unknown>(items: D1PreparedStatement[]) => batch<T>(db, items),
    exec: (sql) => isReadonly(sql) || !needsWriteFence(sql, unrelatedWrites) ? db.exec(sql) : withWrite(() => db.exec(sql)),
    dump: () => db.dump(),
    withSession: (constraint) => {
      const session = db.withSession(constraint);
      return {
        prepare: (sql) => wrapStatement(session.prepare(sql), sql),
        batch: <T = unknown>(items: D1PreparedStatement[]) => batch<T>(session, items),
        getBookmark: () => session.getBookmark(),
      };
    },
  };
}
