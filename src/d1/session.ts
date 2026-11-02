import { AsyncLocalStorage } from 'node:async_hooks';
import type { D1Database, D1DatabaseSession, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import { isD1BindingName, type D1CacheProfile } from './profile';
import type { CacheSessionHooks } from '../core/types';
import { isReadonly } from './adapter';
import { hasCacheBypass } from './request-freshness';
import { D1_BOOKMARK_HEADER, mergeD1Bookmarks, parseD1Bookmarks, decodeD1Bookmarks, serializeD1Bookmarks, type D1Bookmarks } from './bookmarks';

type SessionContext = { input: D1Bookmarks; sessions: Map<string, D1DatabaseSession>; bookmarks: D1Bookmarks; primary: boolean; primaryIds: Set<string>; allowedIds: Set<string>; operations: Map<string, Promise<void>>; closed: boolean };
type DatabaseInfo = { id: string; db: D1Database; primary: boolean };
const storage = new AsyncLocalStorage<SessionContext | undefined>();
const tracking = new AsyncLocalStorage<D1Bookmarks>();
const primarySource = new AsyncLocalStorage<Set<string>>();
type AdmissionGroup = { token: object | undefined; context: SessionContext | undefined; pending: number; waiting: Array<() => void>; tracker: D1Bookmarks; trackers: Map<D1Bookmarks, number>; primary?: Set<string>; ambiguous: boolean };
type AdmissionGate = { active?: AdmissionGroup; waiting: AdmissionGroup[] };
const admissionScope = new AsyncLocalStorage<{ group: AdmissionGroup; tracker?: D1Bookmarks }>();
const prismaScope = new AsyncLocalStorage<object>();
const trackerGroups = new WeakMap<D1Bookmarks, AdmissionGroup>();
const ambiguousTrackers = new WeakSet<D1Bookmarks>();
const infos = new WeakMap<object, DatabaseInfo>();
const facades = new WeakMap<object, Map<string, D1Database>>();
const queues = new Map<string, AdmissionGate>();
const admitted = new Map<string, AdmissionGroup>();
const prismaFacades = new WeakMap<object, D1Database>();

export interface D1ReadSessionOptions extends Pick<D1CacheProfile, 'bindingNames' | 'bindingPrefixes'> {
  databaseIdsEnv: string;
  primaryBindings?: readonly string[];
  freshnessHeader?: string;
  ignoreRequestCacheControl?: boolean;
}

export function registerD1SessionAlias(alias: object, original: object): void {
  const info = infos.get(original);
  if (info) infos.set(alias, info);
}

export function runPrimaryD1SessionSource<T>(operation: () => Promise<T>): Promise<T> {
  return storage.getStore() ? primarySource.run(new Set(), operation) : operation();
}

export function runD1PrismaScope<T>(operation: () => Promise<T>): Promise<T> {
  return prismaScope.run({}, operation);
}

function addTracker(group: AdmissionGroup, tracker: D1Bookmarks | undefined): void {
  if (tracker) {
    group.trackers.set(tracker, (group.trackers.get(tracker) ?? 0) + 1);
    if (group.ambiguous) ambiguousTrackers.add(tracker);
  }
}
function removeTracker(group: AdmissionGroup, tracker: D1Bookmarks | undefined): void {
  if (!tracker) return;
  const count = group.trackers.get(tracker) ?? 0;
  if (count <= 1) group.trackers.delete(tracker);
  else group.trackers.set(tracker, count - 1);
}

export async function runD1SessionOperation<T>(database: object, operation: () => Promise<T>): Promise<T> {
  const info = infos.get(database);
  const current = storage.getStore();
  const context = current && !current.closed ? current : undefined;
  if (!info) return operation();
  const token = context ?? prismaScope.getStore();
  let gate = queues.get(info.id);
  if (!gate) { gate = { waiting:[] }; queues.set(info.id, gate); }
  const scope = gate;
  const active = scope.active;
  const tail = scope.waiting.at(-1);
  const group: AdmissionGroup = token && tail?.token === token ? tail : token && !tail && active?.token === token ? active : { token, context, pending:0, waiting:[], tracker:{}, trackers:new Map(), ambiguous:false };
  const startGroup = (next: AdmissionGroup) => {
    scope.active = next;
    admitted.set(info.id, next);
    trackerGroups.set(next.tracker, next);
    for (const start of next.waiting.splice(0)) start();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      let cancelled = false;
      const start = () => {
        if (cancelled) return;
        if (group.pending > 0) {
          group.ambiguous = true;
          for (const tracker of group.trackers.keys()) ambiguousTrackers.add(tracker);
        }
        group.pending++;
        resolve();
      };
      if (group === active) start();
      else {
        group.waiting.push(start);
        if (group !== tail) {
          if (!active) startGroup(group);
          else scope.waiting.push(group);
        }
      }
      if (!group.pending) timer = setTimeout(() => {
        cancelled = true;
        const index = group.waiting.indexOf(start);
        if (index >= 0) group.waiting.splice(index, 1);
        if (!group.pending && !group.waiting.length) {
          const position = scope.waiting.indexOf(group);
          if (position >= 0) scope.waiting.splice(position, 1);
        }
        reject(new Error('D1 Prisma admission timed out'));
      }, 30_000);
    });
  } finally { if (timer !== undefined) clearTimeout(timer); }
  const tracker = tracking.getStore();
  const primary = primarySource.getStore();
  if (primary && !group.primary) group.primary = primary;
  addTracker(group, tracker);
  try { return await admissionScope.run({ group, tracker }, operation); }
  finally {
    removeTracker(group, tracker);
    group.pending--;
    if (!group.pending) {
      const next = scope.waiting.shift();
      if (next) startGroup(next);
      else { scope.active = undefined; admitted.delete(info.id); queues.delete(info.id); }
    }
  }
}

export function prismaD1SessionDatabase(database: D1Database): D1Database {
  const existing = prismaFacades.get(database);
  if (existing) return existing;
  const info = infos.get(database);
  if (!info) return database;
  const invoke = <T>(operation: () => T): T => {
    const admission = admitted.get(info.id);
    return storage.run(admission?.context, () => admission ? tracking.run(admission.tracker, () => admission.primary ? primarySource.run(admission.primary, operation) : operation()) : operation());
  };
  const statements = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement => {
    function raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
    function raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
    function raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
      return invoke(() => options?.columnNames ? statement.raw<T>({ columnNames:true }) : statement.raw<T>());
    }
    const wrapped: D1PreparedStatement = {
      bind: (...values) => invoke(() => wrapStatement(statement.bind(...values))),
      first: <T = Record<string, unknown>>(column?: string) => invoke(() => column === undefined ? statement.first<T>() : statement.first<T>(column)),
      all: <T = Record<string, unknown>>() => invoke(() => statement.all<T>()),
      run: <T = Record<string, unknown>>() => invoke(() => statement.run<T>()),
      raw,
    };
    statements.set(wrapped, statement);
    return wrapped;
  };
  const wrapSession = (session: D1DatabaseSession): D1DatabaseSession => ({
    prepare: (sql) => invoke(() => wrapStatement(session.prepare(sql))),
    batch: <T = unknown>(items: D1PreparedStatement[]) => invoke(() => session.batch<T>(items.map((item) => statements.get(item) ?? item))),
    getBookmark: () => invoke(() => session.getBookmark()),
  });
  const wrapped: D1Database = {
    prepare: (sql) => invoke(() => wrapStatement(database.prepare(sql))),
    batch: <T = unknown>(items: D1PreparedStatement[]) => invoke(() => database.batch<T>(items.map((item) => statements.get(item) ?? item))),
    withSession: (constraint) => invoke(() => wrapSession(database.withSession(constraint))),
    exec: (sql) => invoke(() => database.exec(sql)),
    dump: () => invoke(() => database.dump()),
  };
  infos.set(wrapped, info);
  prismaFacades.set(database, wrapped);
  return wrapped;
}

function contextFor(): SessionContext | undefined {
  const context = storage.getStore();
  return context && !context.closed ? context : undefined;
}

function sessionFor(info: DatabaseInfo, context: SessionContext, write: boolean): D1DatabaseSession {
  let session = context.sessions.get(info.id);
  const primary = primarySource.getStore();
  const reanchor = !!primary && !primary.has(info.id);
  if (reanchor) { primary.add(info.id); session = undefined; }
  if (!session) {
    session = info.db.withSession(reanchor || write || info.primary || context.primary || context.primaryIds.has(info.id) ? 'first-primary' : context.input[info.id] ?? 'first-unconstrained');
    context.sessions.set(info.id, session);
  }
  return session;
}

function capture(info: DatabaseInfo, context: SessionContext, session: D1DatabaseSession): void {
  const bookmark = session.getBookmark();
  if (bookmark && !context.closed) {
    const combined = { ...context.input };
    if (!mergeD1Bookmarks(combined, context.bookmarks) || !mergeD1Bookmarks(combined, { [info.id]:bookmark })) throw new RangeError('D1 bookmark capacity exceeded');
    mergeD1Bookmarks(context.bookmarks, { [info.id]: bookmark });
    const tracker = tracking.getStore();
    if (tracker) {
      mergeD1Bookmarks(tracker, { [info.id]: bookmark });
      const group = trackerGroups.get(tracker);
      if (group) for (const target of group.trackers.keys()) mergeD1Bookmarks(target, { [info.id]:bookmark });
    }
  }
}

export function runIsolatedD1Session<T>(request: Request, operation: () => Promise<T>): Promise<T> {
  const parent = storage.getStore();
  if (!parent) return operation();
  const input = Object.fromEntries(Object.entries(parseD1Bookmarks(request.headers.get(D1_BOOKMARK_HEADER))).filter(([id]) => parent.allowedIds.has(id)));
  const context: SessionContext = { input, sessions:new Map(), bookmarks:{}, primaryIds:new Set(), allowedIds:parent.allowedIds, operations:new Map(), primary:false, closed:false };
  return storage.run(context, () => tracking.run({}, async () => {
    try { return await operation(); }
    finally { context.closed = true; }
  }));
}

export function d1SessionWarmupRequest(request: Request, response: Response): Request {
  const bookmarks = responseD1SessionBookmarks(response.headers, tracking.getStore() ?? d1SessionBookmarks());
  if (!bookmarks) return request;
  const headers = new Headers(request.headers);
  const encoded = serializeD1Bookmarks(bookmarks);
  if (encoded) headers.set(D1_BOOKMARK_HEADER, encoded);
  return new Request(request, { headers });
}

export function d1SessionBookmarkFloor(): D1Bookmarks | undefined {
  const context = storage.getStore();
  return context && !context.closed ? { ...context.input } : undefined;
}
export function d1SessionBookmarks(): D1Bookmarks | undefined {
  const context = storage.getStore();
  return context && !context.closed ? { ...context.bookmarks } : undefined;
}
export function varyD1Bookmarks(headers: Headers): void {
  const vary = headers.get('vary');
  const names = vary ? vary.split(',').map((name) => name.trim()).filter(Boolean) : [];
  if (!names.some((name) => name === '*' || name.toLowerCase() === D1_BOOKMARK_HEADER.toLowerCase())) headers.set('vary', [...names, D1_BOOKMARK_HEADER].join(', '));
}
export function responseD1SessionBookmarks(headers: Headers, source?: D1Bookmarks): D1Bookmarks | undefined {
  const context = storage.getStore();
  if (!context || context.closed) return undefined;
  const result = { ...context.input };
  const upstream = decodeD1Bookmarks(headers.get(D1_BOOKMARK_HEADER));
  if (upstream && !mergeD1Bookmarks(result, Object.fromEntries(Object.entries(upstream).filter(([id]) => context.allowedIds.has(id))))) throw new RangeError('D1 bookmark capacity exceeded');
  if (source && !mergeD1Bookmarks(result, source)) throw new RangeError('D1 bookmark capacity exceeded');
  return result;
}
export function d1SessionResponseBookmarks(): D1Bookmarks | undefined {
  const context = storage.getStore();
  if (!context || context.closed) return undefined;
  const result = { ...context.input };
  mergeD1Bookmarks(result, tracking.getStore() ?? context.bookmarks);
  return result;
}
export function advanceD1SessionBookmarks(bookmarks: D1Bookmarks): void {
  const context = storage.getStore();
  if (context && !context.closed) {
    const filtered = Object.fromEntries(Object.entries(bookmarks).filter(([id]) => context.allowedIds.has(id)));
    const combined = { ...context.input };
    if (!mergeD1Bookmarks(combined, context.bookmarks) || !mergeD1Bookmarks(combined, filtered)) throw new RangeError('D1 bookmark capacity exceeded');
    mergeD1Bookmarks(context.bookmarks, filtered);
    const tracker = tracking.getStore();
    if (tracker) mergeD1Bookmarks(tracker, filtered);
  }
}

export async function trackD1SessionSource<T>(operation: () => Promise<T>): Promise<{ value: T; bookmarks?: D1Bookmarks }> {
  const context = storage.getStore();
  if (!context || context.closed) return { value:await operation() };
  const parent = tracking.getStore();
  const tracker: D1Bookmarks = {};
  const admission = admissionScope.getStore();
  const previous = admission?.tracker;
  if (admission) { removeTracker(admission.group, previous); admission.tracker = tracker; addTracker(admission.group, tracker); }
  try {
    const value = await tracking.run(tracker, operation);
    if (parent) mergeD1Bookmarks(parent, tracker);
    return { value, bookmarks:tracker };
  }
  finally { if (admission) { removeTracker(admission.group, tracker); admission.tracker = previous; addTracker(admission.group, previous); } }
}

async function serialSession<T>(context: SessionContext, id: string, operation: () => Promise<T>): Promise<T> {
  const previous = context.operations.get(id) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => next);
  context.operations.set(id, tail);
  await previous;
  try { return await operation(); }
  finally { release(); if (context.operations.get(id) === tail) context.operations.delete(id); }
}

export function wrapD1SessionCacheValue(value: unknown, source?: D1Bookmarks): unknown {
  const bookmarks = source ?? tracking.getStore() ?? d1SessionBookmarks();
  if (bookmarks && (ambiguousTrackers.has(bookmarks) || admissionScope.getStore()?.group.ambiguous)) return { d1SessionCache:0 };
  return bookmarks ? { d1SessionCache: 1, bookmarks, value } : value;
}

export function unwrapD1SessionCacheValue(value: unknown, databaseIds: readonly string[]): { value: unknown; bookmarks?: D1Bookmarks } | null {
  const floor = d1SessionBookmarkFloor();
  if (!floor) return { value };
  if (!value || typeof value !== 'object' || Reflect.get(value, 'd1SessionCache') !== 1 || !Reflect.has(value, 'value')) return null;
  const raw: unknown = Reflect.get(value, 'bookmarks');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const serialized = JSON.stringify(raw);
  const bookmarks = parseD1Bookmarks(serialized);
  if (Object.keys(bookmarks).length !== Object.keys(raw).length) return null;
  if (databaseIds.some((id) => floor[id] !== undefined && (!bookmarks[id] || bookmarks[id] < floor[id]))) return null;
  return { value: Reflect.get(value, 'value'), bookmarks };
}

export function d1SessionCacheHooks(database: object): CacheSessionHooks {
  return {
    key: () => d1SessionBookmarkFloor() ? 'd1-session-v1' : null,
    read(value) {
      const info = infos.get(database);
      if (d1SessionBookmarkFloor() && !info) return null;
      const cached = unwrapD1SessionCacheValue(value, info ? [info.id] : []);
      if (d1SessionBookmarkFloor() && info && !cached?.bookmarks?.[info.id]) return null;
      if (cached?.bookmarks) advanceD1SessionBookmarks(cached.bookmarks);
      return cached;
    },
    background(operation) {
      const bookmarks = d1SessionResponseBookmarks();
      if (!bookmarks) return operation();
      const encoded = serializeD1Bookmarks(bookmarks);
      const request = new Request('https://d1-session.invalid/', { headers:encoded ? { [D1_BOOKMARK_HEADER]:encoded } : {} });
      return runIsolatedD1Session(request, operation);
    },
    async fill(load) {
      const tracked = await trackD1SessionSource(() => runPrimaryD1SessionSource(load));
      const active = d1SessionBookmarkFloor();
      const info = infos.get(database);
      const cached = active && (!info || !tracked.bookmarks?.[info.id]) ? { d1SessionCache:0 } : wrapD1SessionCacheValue(tracked.value, tracked.bookmarks);
      return { value:tracked.value, cached };
    },
  };
}

function facade(info: DatabaseInfo): D1Database {
  type Statement = { sql: string; values: unknown[] };
  const statements = new WeakMap<D1PreparedStatement, Statement>();
  const prepare = (sql: string, values: unknown[] = []): D1PreparedStatement => {
    const execute = async <T>(action: (statement: D1PreparedStatement) => Promise<T>): Promise<T> => {
      const context = contextFor();
      if (!context) return action(info.db.prepare(sql).bind(...values));
      return serialSession(context, info.id, async () => {
        const session = sessionFor(info, context, !isReadonly(sql));
        const result = await action(session.prepare(sql).bind(...values));
        capture(info, context, session);
        return result;
      });
    };
    function raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
    function raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
    function raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
      return execute<T[] | [string[], ...T[]]>((statement) => options?.columnNames ? statement.raw<T>({ columnNames:true }) : statement.raw<T>());
    }
    const result: D1PreparedStatement = {
      bind: (...next) => prepare(sql, next),
      first: <T = Record<string, unknown>>(column?: string) => execute((statement) => column === undefined ? statement.first<T>() : statement.first<T>(column)),
      run: <T = Record<string, unknown>>() => execute((statement) => statement.run<T>()),
      all: <T = Record<string, unknown>>() => execute((statement) => statement.all<T>()),
      raw,
    };
    statements.set(result, { sql, values });
    return result;
  };
  const batch = async <T = unknown>(items: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
    const definitions = items.map((item) => statements.get(item));
    const context = contextFor();
    if (!context) return info.db.batch<T>(items.map((item, index) => {
      const definition = definitions[index];
      return definition ? info.db.prepare(definition.sql).bind(...definition.values) : item;
    }));
    if (definitions.some((item) => !item)) throw new TypeError('D1 batch statements must use the same database facade');
    const execute = async (target: D1Database | D1DatabaseSession, session?: D1DatabaseSession) => {
      const raw = definitions.map((item) => {
        if (!item) throw new TypeError('Invalid D1 statement');
        return target.prepare(item.sql).bind(...item.values);
      });
      const result = await target.batch<T>(raw);
      if (session && context) capture(info, context, session);
      return result;
    };
    return serialSession(context, info.id, () => {
      const session = sessionFor(info, context, definitions.some((item) => item && !isReadonly(item.sql)));
      return execute(session, session);
    });
  };
  const database: D1Database = {
    prepare,
    batch,
    exec: async (sql) => {
      const context = contextFor();
      if (!context) return info.db.exec(sql);
      return serialSession(context, info.id, async () => {
        const result = await info.db.exec(sql);
        const session = info.db.withSession('first-primary');
        await session.prepare('SELECT 1').first();
        context.sessions.set(info.id, session);
        capture(info, context, session);
        return result;
      });
    },
    dump: () => info.db.dump(),
    withSession: (constraint) => {
      const context = contextFor();
      if (!context) return info.db.withSession(constraint);
      if (constraint && constraint !== 'first-unconstrained' && constraint !== context.input[info.id]) {
        if (constraint === 'first-primary' && (!context.sessions.has(info.id) || context.primary || info.primary || context.primaryIds.has(info.id))) { context.primaryIds.add(info.id); return { prepare, batch, getBookmark: () => context.sessions.get(info.id)?.getBookmark() ?? null }; }
        throw new Error('Explicit D1 session constraint conflicts with request session');
      }
      return { prepare, batch, getBookmark: () => context.sessions.get(info.id)?.getBookmark() ?? null };
    },
  };
  infos.set(database, info);
  return database;
}

export function sessionD1Env<Env extends object>(env: Env, options: D1ReadSessionOptions): Env {
    const raw: unknown = Reflect.get(env, options.databaseIdsEnv);
    if (raw === undefined) return env;
    let parsed: unknown;
    try { parsed = typeof raw === 'string' ? JSON.parse(raw) : null; } catch { parsed = null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Invalid ${options.databaseIdsEnv}`);
    const ids = Object.fromEntries(Object.entries(parsed).map(([name, id]) => {
      if (!isD1BindingName(name, { ...options, envPrefix:'', coordinatorNamePrefix:'', coordinatorClass:'', readModels:[], unfencedWriteTables:[] }) || typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid D1 database identity');
      return [name, id.toLowerCase()];
    }));
    const primaryIds = new Set((options.primaryBindings ?? []).map((name) => ids[name]).filter((id): id is string => typeof id === 'string'));
    const scoped = { ...env };
    for (const name of options.bindingNames) if (!Reflect.has(env, name)) throw new Error(`Missing D1 binding: ${name}`);
    for (const [name, db] of Object.entries(env)) {
      if (options.bindingPrefixes.some((prefix) => name.startsWith(prefix)) && !isD1BindingName(name, { ...options, envPrefix:'', coordinatorNamePrefix:'', coordinatorClass:'', readModels:[], unfencedWriteTables:[] })) throw new Error(`Invalid D1 binding: ${name}`);
      if (!isD1BindingName(name, { ...options, envPrefix:'', coordinatorNamePrefix:'', coordinatorClass:'', readModels:[], unfencedWriteTables:[] })) continue;
      const id: string | undefined = ids[name];
      if (!id || !db || typeof db !== 'object' || typeof Reflect.get(db, 'withSession') !== 'function') throw new Error(`Missing D1 identity or binding: ${name}`);
      const primary = primaryIds.has(id);
      let variants = facades.get(db);
      if (!variants) { variants = new Map(); facades.set(db, variants); }
      const key = `${id}:${primary}`;
      let wrapped = variants.get(key);
      if (!wrapped) { wrapped = facade({ id, db: db as D1Database, primary }); variants.set(key, wrapped); }
      Reflect.set(scoped, name, wrapped);
    }
    return scoped;
}

export function wrapD1ReadSessionHandler<Env extends object, Context>(handler: (request: Request, env: Env, context: Context) => Promise<Response>, options: D1ReadSessionOptions): (request: Request, env: Env, context: Context) => Promise<Response> {
  return async (request, env, context) => {
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') return handler(request, env, context);
    if (Reflect.get(env, options.databaseIdsEnv) === undefined) return handler(request, env, context);
    const scoped = sessionD1Env(env, options);
    const decoded = decodeD1Bookmarks(request.headers.get(D1_BOOKMARK_HEADER));
    if (!decoded) return new Response('Invalid D1 bookmarks', { status:400 });
    const configured = new Set(Object.entries(scoped).flatMap(([name, value]) => isD1BindingName(name, { ...options, envPrefix:'', coordinatorNamePrefix:'', coordinatorClass:'', readModels:[], unfencedWriteTables:[] }) && value && typeof value === 'object' ? [infos.get(value)?.id].filter((id): id is string => !!id) : []));
    const input = Object.fromEntries(Object.entries(decoded).filter(([id]) => configured.has(id))); 
    const sessionContext: SessionContext = { input, sessions:new Map(), bookmarks:{}, primaryIds:new Set(), allowedIds:configured, operations:new Map(), primary: !['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase()) || (options.ignoreRequestCacheControl !== true && hasCacheBypass(request)) || (options.freshnessHeader !== undefined && request.headers.has(options.freshnessHeader)), closed:false };
    return storage.run(sessionContext, async () => {
      try {
        const tracked = await trackD1SessionSource(() => handler(request, scoped, context));
        const response = tracked.value;
        if (response.status === 101) return response;
        const headers = new Headers(response.headers);
        varyD1Bookmarks(headers);
        const responseBookmarks = responseD1SessionBookmarks(headers, tracked.bookmarks) ?? {};
        sessionContext.closed = true;
        const encoded = serializeD1Bookmarks(responseBookmarks);
        if (encoded && encoded !== '{}') headers.set(D1_BOOKMARK_HEADER, encoded);
        else headers.delete(D1_BOOKMARK_HEADER);
        return new Response(response.body, { status:response.status, statusText:response.statusText, headers });
      } finally { sessionContext.closed = true; }
    });
  };
}
