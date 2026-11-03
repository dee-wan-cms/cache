import { describe, expect, it, vi } from 'vitest';
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { limitReadResponseLeaseUntil, wrapReadResponseLease } from '../../src/http-response-lease';
import { cacheRegionalResponse } from '../../src/d1/regional-response';
import { createCacheExtension } from '../../src/core/extension';
import { CONFIG_FORMAT } from '../../src/core/limits';
import type { CacheStore, GeneratedCacheConfig } from '../../src/core/types';
import { prismaD1SessionDatabase, registerD1SessionAlias, runD1SessionOperation, runD1PrismaScope, d1SessionCacheHooks, sessionD1Env, wrapD1ReadSessionHandler } from '../../src/d1/session';
import { D1_BOOKMARK_HEADER } from '../../src/d1/bookmarks';

const id = '00000000-0000-0000-0000-000000000001';
const options = { bindingNames:['DB'], bindingPrefixes:['SITE_'], databaseIdsEnv:'IDS', primaryBindings:['DB'] };

function mockDatabase() {
  let version = 0;
  const anchors: string[] = [];
  const meta = { duration:0, size_after:0, rows_read:0, rows_written:0, last_row_id:0, changed_db:false, changes:0 };
  const statement = (source: string, bookmark: () => void): D1PreparedStatement => {
    function raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
    function raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
    async function raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
      bookmark();
      return options?.columnNames ? [[]] : [];
    }
    return {
      bind: () => statement(source, bookmark),
      async first<T = Record<string, unknown>>() { bookmark(); return { source } as T; },
      async all<T = Record<string, unknown>>() { bookmark(); return { results:[{ source } as T], success:true, meta }; },
      async run<T = Record<string, unknown>>() { bookmark(); return { results:[] as T[], success:true, meta }; },
      raw,
    };
  };
  const db: D1Database = {
    prepare: () => statement('raw', () => {}),
    batch: async () => [],
    exec: async () => ({ count:1, duration:0 }),
    dump: async () => new ArrayBuffer(0),
    withSession: (anchor = 'first-unconstrained') => {
      anchors.push(anchor);
      let current: string | null = null;
      const note = () => { current = String(++version).padStart(8, '0'); };
      return { prepare: () => statement(anchor, note), batch: async () => { note(); return []; }, getBookmark: () => current };
    },
  };
  return { db, anchors };
}

describe('D1 session facade', () => {
  it('reuses an existing session facade without stripping registered wrappers', async () => {
    const { db, anchors } = mockDatabase();
    const env = { DB:db, IDS:JSON.stringify({ DB:id }) };
    const once = sessionD1Env(env, options);
    const twice = sessionD1Env(once, options);
    expect(twice.DB).toBe(once.DB);
    const otherPolicy = sessionD1Env(once, { ...options, primaryBindings:[] });
    expect(otherPolicy.DB).not.toBe(once.DB);
    expect(sessionD1Env(otherPolicy, options).DB).toBe(once.DB);
    const alias: D1Database = {
      prepare:vi.fn(once.DB.prepare), batch:once.DB.batch, exec:once.DB.exec,
      withSession:once.DB.withSession, dump:once.DB.dump,
    };
    registerD1SessionAlias(alias, once.DB);
    expect(sessionD1Env({ ...env, DB:alias }, options).DB).toBe(alias);
    expect(() => sessionD1Env({ ...env, DB:alias }, { ...options, primaryBindings:[] })).toThrow();
    const prisma = prismaD1SessionDatabase(once.DB);
    expect(sessionD1Env({ ...env, DB:prisma }, options).DB).toBe(prisma);
    expect(() => sessionD1Env({ ...once, IDS:JSON.stringify({ DB:'00000000-0000-0000-0000-000000000002' }) }, options)).toThrow();
    const inner = wrapD1ReadSessionHandler(async (_request, scoped: typeof env) => {
      await scoped.DB.prepare('SELECT 1').first();
      return new Response('ok');
    }, options);
    const outer = wrapD1ReadSessionHandler((request, scoped: typeof env) => inner(request, scoped, null), options);
    const response = await outer(new Request('https://example.test/'), env, null);
    expect(response.status).toBe(200);
    expect(anchors).toEqual(['first-primary']);
    expect(JSON.parse(response.headers.get(D1_BOOKMARK_HEADER) ?? '{}')).toEqual({ [id]:'00000001' });
    const aliasResponse = await inner(new Request('https://example.test/'), { ...env, DB:alias }, null);
    expect(aliasResponse.status).toBe(200);
    expect(alias.prepare).toHaveBeenCalled();
    const prismaHandler = wrapD1ReadSessionHandler(async (_request, scoped: typeof env) => {
      await runD1SessionOperation(scoped.DB, () => scoped.DB.prepare('SELECT 1').first());
      return new Response('ok');
    }, options);
    const prismaResponse = await prismaHandler(new Request('https://example.test/'), { ...env, DB:prisma }, null);
    expect(JSON.parse(prismaResponse.headers.get(D1_BOOKMARK_HEADER) ?? '{}')).toEqual({ [id]:'00000003' });
  });
  it('preserves absent configuration and shares one physical session across aliases', async () => {
    const { db, anchors } = mockDatabase();
    const absent = { DB:db };
    expect(sessionD1Env(absent, options)).toBe(absent);
    const env = { DB:db, SITE_alias:db, IDS:JSON.stringify({ DB:id, SITE_alias:id }) };
    const wrapped = wrapD1ReadSessionHandler(async (_request, value: typeof env) => {
      await value.DB.prepare('SELECT 1').first();
      await value.SITE_alias.prepare('SELECT 1').first();
      return new Response('ok');
    }, options);
    const response = await wrapped(new Request('https://example.test/'), env, null);
    expect(anchors).toEqual(['first-primary']);
    expect(JSON.parse(response.headers.get(D1_BOOKMARK_HEADER) ?? '{}')).toEqual({ [id]:'00000002' });
    expect(sessionD1Env(env, options).DB).toBe(sessionD1Env(env, options).DB);
  });

  it('keeps direct background calls outside Prisma admission and queues background Prisma', async () => {
    const { db } = mockDatabase();
    const env = { DB:db, IDS:JSON.stringify({ DB:id }) };
    const facade = sessionD1Env(env, options).DB;
    const prisma = prismaD1SessionDatabase(facade);
    let release!: () => void;
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const handler = wrapD1ReadSessionHandler(async () => {
      await runD1SessionOperation(facade, async () => { entered(); await gate; await prisma.prepare('SELECT 1').first(); });
      return new Response('ok');
    }, options);
    const request = handler(new Request('https://example.test/'), env, null);
    await inside;
    const direct = await facade.prepare('SELECT 1').first<{ source:string }>();
    let backgroundDone = false;
    const background = runD1SessionOperation(facade, async () => { const result = await prisma.prepare('SELECT 1').first<{ source:string }>(); backgroundDone = true; return result; });
    expect(direct?.source).toBe('raw');
    expect(backgroundDone).toBe(false);
    release();
    await request;
    expect((await background)?.source).toBe('raw');
  });
});

it('rejects cache values below the input floor and advances from their source', async () => {
  const { db } = mockDatabase();
  const env = { DB:db, IDS:JSON.stringify({ DB:id }) };
  const { trackD1SessionSource, wrapD1SessionCacheValue, unwrapD1SessionCacheValue, advanceD1SessionBookmarks } = await import('../../src/d1/session');
  let cached: unknown;
  const load = wrapD1ReadSessionHandler(async (_request, value: typeof env) => {
    const result = await trackD1SessionSource(() => value.DB.prepare('SELECT 1').first());
    cached = wrapD1SessionCacheValue(result.value, result.bookmarks);
    return new Response();
  }, options);
  await load(new Request('https://example.test/'), env, null);
  const consume = wrapD1ReadSessionHandler(async () => {
    const entry = unwrapD1SessionCacheValue(cached, [id]);
    if (entry?.bookmarks) advanceD1SessionBookmarks(entry.bookmarks);
    return Response.json({ hit:!!entry });
  }, options);
  const equal = await consume(new Request('https://example.test/', { headers:{ [D1_BOOKMARK_HEADER]:JSON.stringify({ [id]:'00000001' }) } }), env, null);
  expect(await equal.json()).toEqual({ hit:true });
  const newer = await consume(new Request('https://example.test/', { headers:{ [D1_BOOKMARK_HEADER]:JSON.stringify({ [id]:'00000002' }) } }), env, null);
  expect(await newer.json()).toEqual({ hit:false });
  const malformed = await consume(new Request('https://example.test/', { headers:{ [D1_BOOKMARK_HEADER]:'invalid' } }), env, null);
  expect(malformed.status).toBe(400);
  const other = '00000000-0000-0000-0000-000000000002';
  const filtered = await consume(new Request('https://example.test/', { headers:{ [D1_BOOKMARK_HEADER]:JSON.stringify({ [other]:'99999999' }) } }), env, null);
  expect(await filtered.json()).toEqual({ hit:true });
  expect(JSON.parse(filtered.headers.get(D1_BOOKMARK_HEADER) ?? '{}')).toEqual({ [id]:'00000001' });
});

it('reuses a warmed response only when its source covers the requested bookmark', async () => {
  const entries = new Map<string, Response>();
  vi.stubGlobal('caches', { default:{ match:async (key: string) => entries.get(key)?.clone(), put:async (key: string, value: Response) => { entries.set(key, value.clone()); } } });
  try {
    const { db } = mockDatabase();
    const env = { DB:db, IDS:JSON.stringify({ DB:id }) };
    const calls: string[] = [];
    const handler = async (req: Request, value: typeof env) => {
      calls.push(new URL(req.url).pathname);
      await value.DB.prepare('SELECT 1').first();
      limitReadResponseLeaseUntil(Date.now() + 5000);
      return Response.json({ path:new URL(req.url).pathname });
    };
    const lease = wrapReadResponseLease(handler, { namespace:'d1-session-warm', deployment:'1', database:id, seconds:5, maxSeconds:5, paths:['/api/**'], credentialHeaders:['cookie'], varyHeaders:['x-site-id'], freshnessCookie:'fresh', warmup:{ scopeHeader:'x-site-id', seeds:['/api/sibling'] } });
    const wrapped = wrapD1ReadSessionHandler(lease, options);
    const jobs: Promise<unknown>[] = [];
    const context = { waitUntil(promise: Promise<unknown>) { jobs.push(promise); } };
    const request = (path: string, bookmark?: string) => new Request(`https://example.test${path}`, { headers:{ cookie:'session=a', 'x-site-id':'one', ...(bookmark ? { [D1_BOOKMARK_HEADER]:bookmark } : {}) } });
    const first = await wrapped(request('/api/first'), env, context);
    const floor = first.headers.get(D1_BOOKMARK_HEADER) ?? '';
    expect(first.headers.get('vary')?.toLowerCase()).toContain(D1_BOOKMARK_HEADER.toLowerCase());
    while (jobs.length) await Promise.all(jobs.splice(0));
    expect(JSON.parse(floor)).toEqual({ [id]:'00000001' });
    const sibling = await wrapped(request('/api/sibling', floor), env, context);
    expect(await sibling.json()).toEqual({ path:'/api/sibling' });
    expect(calls.filter((path) => path === '/api/sibling')).toHaveLength(1);
    expect(JSON.parse(sibling.headers.get(D1_BOOKMARK_HEADER) ?? '{}')).toEqual({ [id]:'00000002' });
    await wrapped(request('/api/sibling', JSON.stringify({ [id]:'00000003' })), env, context);
    expect(calls.filter((path) => path === '/api/sibling')).toHaveLength(2);
    while (jobs.length) await Promise.all(jobs.splice(0));
  } finally { vi.unstubAllGlobals(); }
});

it('times out queued Prisma admission without disturbing its active owner', async () => {
  vi.useFakeTimers();
  try {
    const { db } = mockDatabase();
    const facade = sessionD1Env({ DB:db, IDS:JSON.stringify({ DB:id }) }, options).DB;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const owner = runD1SessionOperation(facade, () => hold);
    await Promise.resolve();
    const skipped = vi.fn(async () => 'unexpected');
    const waiting = runD1SessionOperation(facade, skipped);
    const failure = expect(waiting).rejects.toThrow('D1 Prisma admission timed out');
    await vi.advanceTimersByTimeAsync(30_000);
    await failure;
    let nextStarted = false;
    const next = runD1SessionOperation(facade, async () => { nextStarted = true; });
    await Promise.resolve();
    expect(nextStarted).toBe(false);
    expect(skipped).not.toHaveBeenCalled();
    release();
    await owner;
    await next;
    expect(nextStarted).toBe(true);
  } finally { vi.useRealTimers(); }
});

it('admits a nested operation while preserving queued request order and bookmarks', async () => {
  vi.useFakeTimers();
  try {
    const { db } = mockDatabase();
    const env = { DB:db, IDS:JSON.stringify({ DB:id }) };
    const facade = sessionD1Env(env, options).DB;
    const prisma = prismaD1SessionDatabase(facade);
    const events: string[] = [];
    let entered!: () => void;
    let continueOwner!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const proceed = new Promise<void>((resolve) => { continueOwner = resolve; });
    const handler = wrapD1ReadSessionHandler(async (request) => {
      const name = new URL(request.url).pathname.slice(1);
      await runD1SessionOperation(facade, async () => {
        events.push(`${name}:start`);
        if (name === 'owner') {
          entered();
          await proceed;
          await runD1SessionOperation(facade, async () => {
            events.push('nested:start');
            await prisma.prepare('SELECT 1').first();
            events.push('nested:end');
          });
        } else {
          await prisma.prepare('SELECT 1').first();
        }
        events.push(`${name}:end`);
      });
      return new Response('ok');
    }, options);
    const owner = handler(new Request('https://example.test/owner'), env, null);
    const ownerResult = owner.then((response) => response, (error: Error) => error);
    await inside;
    const first = handler(new Request('https://example.test/first'), env, null);
    const second = handler(new Request('https://example.test/second'), env, null);
    const results = Promise.all([first, second]).then((responses) => responses, (error: Error) => error);
    continueOwner();
    await vi.advanceTimersByTimeAsync(30_000);
    const response = await ownerResult;
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw response;
    const others = await results;
    if (!Array.isArray(others)) throw others;
    expect(events).toEqual(['owner:start', 'nested:start', 'nested:end', 'owner:end', 'first:start', 'first:end', 'second:start', 'second:end']);
    expect(JSON.parse(response.headers.get(D1_BOOKMARK_HEADER) ?? '{}')).toEqual({ [id]:'00000001' });
    expect(others.map((item) => JSON.parse(item.headers.get(D1_BOOKMARK_HEADER) ?? '{}'))).toEqual([{ [id]:'00000002' }, { [id]:'00000003' }]);
  } finally { vi.useRealTimers(); }
});

it('admits a nested operation without a request session while another operation waits', async () => {
  vi.useFakeTimers();
  try {
    const { db } = mockDatabase();
    const facade = sessionD1Env({ DB:db, IDS:JSON.stringify({ DB:id }) }, options).DB;
    const events: string[] = [];
    let entered!: () => void;
    let resume!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const proceed = new Promise<void>((resolve) => { resume = resolve; });
    const owner = runD1SessionOperation(facade, async () => {
      events.push('owner');
      entered();
      await proceed;
      await runD1SessionOperation(facade, async () => { events.push('nested'); });
    });
    const outcome = owner.then(() => null, (error: Error) => error);
    await inside;
    const waiting = runD1SessionOperation(facade, async () => { events.push('waiting'); });
    const queued = waiting.then(() => null, (error: Error) => error);
    resume();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await outcome).toBeNull();
    expect(await queued).toBeNull();
    expect(events).toEqual(['owner', 'nested', 'waiting']);
  } finally { vi.useRealTimers(); }
});

it('admits sibling operations from the active request ahead of another queued request', async () => {
  vi.useFakeTimers();
  try {
    const { db } = mockDatabase();
    const env = { DB:db, IDS:JSON.stringify({ DB:id }) };
    const facade = sessionD1Env(env, options).DB;
    const events: string[] = [];
    let firstEntered!: () => void;
    let nextSibling!: () => void;
    let bothEntered!: () => void;
    const firstReady = new Promise<void>((resolve) => { firstEntered = resolve; });
    const proceed = new Promise<void>((resolve) => { nextSibling = resolve; });
    const bothReady = new Promise<void>((resolve) => { bothEntered = resolve; });
    const handler = wrapD1ReadSessionHandler(async (request) => {
      if (new URL(request.url).pathname === '/owner') {
        const first = runD1SessionOperation(facade, async () => {
          events.push('first');
          firstEntered();
          await bothReady;
        });
        await proceed;
        const second = runD1SessionOperation(facade, async () => { events.push('second'); bothEntered(); });
        await Promise.all([first, second]);
      } else await runD1SessionOperation(facade, async () => { events.push('other'); });
      return new Response('ok');
    }, options);
    const owner = handler(new Request('https://example.test/owner'), env, null).then(() => null, (error: Error) => error);
    await firstReady;
    const other = handler(new Request('https://example.test/other'), env, null).then(() => null, (error: Error) => error);
    nextSibling();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await owner).toBeNull();
    expect(await other).toBeNull();
    expect(events).toEqual(['first', 'second', 'other']);
  } finally { vi.useRealTimers(); }
});

it('admits operations from one scheduled invocation together', async () => {
  const { db } = mockDatabase();
  const facade = sessionD1Env({ DB:db, IDS:JSON.stringify({ DB:id }) }, options).DB;
  let started = 0;
  let release!: () => void;
  const both = new Promise<void>((resolve) => { release = resolve; });
  await runD1PrismaScope(() => Promise.all([1, 2].map(() => runD1SessionOperation(facade, async () => {
    if (++started === 2) release();
    await both;
  }))));
  expect(started).toBe(2);
});

it('reuses a regional HTTP response only at a covered bookmark floor', async () => {
  const entries = new Map<string, Response>();
  vi.stubGlobal('caches', { default:{ match:async (key: string) => entries.get(key)?.clone(), put:async (key: string, value: Response) => { entries.set(key, value.clone()); } } });
  try {
    const { db } = mockDatabase();
    const env = { DB:db, IDS:JSON.stringify({ DB:id }) };
    let calls = 0;
    const handler = wrapD1ReadSessionHandler((request, value: typeof env) => cacheRegionalResponse(request, { namespace:'sessions', ttlMs:5000 }, async () => {
      calls++;
      await value.DB.prepare('SELECT 1').first();
      return Response.json({ calls }, { headers:{ 'cache-control':'public, s-maxage=5' } });
    }), options);
    const first = await handler(new Request('https://example.test/data'), env, null);
    const floor = first.headers.get(D1_BOOKMARK_HEADER) ?? '';
    const hit = await handler(new Request('https://example.test/data', { headers:{ [D1_BOOKMARK_HEADER]:floor } }), env, null);
    expect(await hit.json()).toEqual({ calls:1 });
    expect(hit.headers.get(D1_BOOKMARK_HEADER)).toBe(floor);
    await handler(new Request('https://example.test/data', { headers:{ [D1_BOOKMARK_HEADER]:JSON.stringify({ [id]:'00000003' }) } }), env, null);
    expect(calls).toBe(2);
  } finally { vi.unstubAllGlobals(); }
});

it('refreshes a leased response in an isolated background session', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  const entries = new Map<string, Response>();
  vi.stubGlobal('caches', { default:{ match:async (key: string) => entries.get(key)?.clone(), put:async (key: string, value: Response) => { entries.set(key, value.clone()); } } });
  try {
    const { db } = mockDatabase();
    const env = { DB:db, IDS:JSON.stringify({ DB:id }) };
    let calls = 0;
    const lease = wrapReadResponseLease(async (_request: Request, value: typeof env) => {
      calls++;
      await value.DB.prepare('SELECT 1').first();
      limitReadResponseLeaseUntil(Date.now() + 5000);
      return Response.json({ calls });
    }, { namespace:'session-refresh', deployment:'1', database:id, seconds:5, maxSeconds:5, refreshAheadSeconds:2, paths:['/items'], credentialHeaders:['cookie'], varyHeaders:[], freshnessCookie:'fresh' });
    const handler = wrapD1ReadSessionHandler(lease, options);
    const jobs: Promise<unknown>[] = [];
    const ctx = { waitUntil(job: Promise<unknown>) { jobs.push(job); } };
    const request = (bookmark?: string) => new Request('https://example.test/items', { headers:{ cookie:'session=a', ...(bookmark ? { [D1_BOOKMARK_HEADER]:bookmark } : {}) } });
    const first = await handler(request(), env, ctx);
    const floor = first.headers.get(D1_BOOKMARK_HEADER) ?? '';
    await Promise.all(jobs.splice(0));
    vi.setSystemTime(13_500);
    const second = await handler(request(floor), env, ctx);
    expect(await second.json()).toEqual({ calls:1 });
    expect(second.headers.get(D1_BOOKMARK_HEADER)).toBe(floor);
    await Promise.all(jobs.splice(0));
    const third = await handler(request(floor), env, ctx);
    expect(await third.json()).toEqual({ calls:2 });
    expect(JSON.parse(third.headers.get(D1_BOOKMARK_HEADER) ?? '{}')).toEqual({ [id]:'00000002' });
  } finally { vi.unstubAllGlobals(); vi.useRealTimers(); }
});

it('uses primary for explicit source freshness without treating ignored cache control as freshness', async () => {
  const { db, anchors } = mockDatabase();
  const env = { DB:db, IDS:JSON.stringify({ DB:id }) };
  const handler = (ignoreRequestCacheControl: boolean) => wrapD1ReadSessionHandler(async (_request: Request, value: typeof env) => {
    await value.DB.prepare('SELECT 1').first();
    return new Response();
  }, { ...options, primaryBindings:[], freshnessHeader:'X-Read-Fresh', ignoreRequestCacheControl });
  await handler(false)(new Request('https://example.test/'), env, null);
  await handler(false)(new Request('https://example.test/', { headers:{ 'Cache-Control':'no-cache' } }), env, null);
  await handler(true)(new Request('https://example.test/', { headers:{ 'Cache-Control':'no-cache' } }), env, null);
  await handler(true)(new Request('https://example.test/', { headers:{ 'X-Read-Fresh':'1' } }), env, null);
  expect(anchors).toEqual(['first-unconstrained', 'first-primary', 'first-unconstrained', 'first-primary']);
});

it('anchors a generic cache fill on primary after an earlier replica read', async () => {
  const { db, anchors } = mockDatabase();
  const env = { DB:db, IDS:JSON.stringify({ DB:id }) };
  let stored: string | undefined;
  const store: CacheStore = {
    read:async () => stored ? { kind:'hit', value:stored, epochs:{ g:1 }, refreshToken:null } : { kind:'miss', epochs:{ g:1 }, lockHeldForMs:null, lockToken:'lock', pending:false },
    write:async (request) => { stored = request.value; return { ok:true }; },
    release:async () => {}, beginWrite:async () => {}, endWrite:async () => {}, invalidate:async () => {},
  };
  const config: GeneratedCacheConfig = { cacheVersion:'1', configFormat:CONFIG_FORMAT, hasDecimalFields:false, modelNames:['Row'], cacheableByModel:{ Row:true }, primaryKeyFieldsByModel:{ Row:['id'] }, primaryKeyNameByModel:{}, relationGraph:{} };
  const handler = wrapD1ReadSessionHandler(async (_request: Request, value: typeof env) => {
    await value.DB.prepare('SELECT 1').first();
    const extension = createCacheExtension({ config, store, sessionCache:d1SessionCacheHooks(value.DB) });
    const result = await extension.query.$allModels.$allOperations({ model:'Row', operation:'findMany', args:{}, query:async () => value.DB.prepare('SELECT 1').first() });
    return Response.json(result);
  }, { ...options, primaryBindings:[] });
  const result = await handler(new Request('https://example.test/'), env, null);
  expect(await result.json()).toEqual({ source:'first-primary' });
  expect(anchors).toEqual(['first-unconstrained', 'first-primary']);
});
