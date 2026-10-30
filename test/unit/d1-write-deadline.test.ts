import { afterEach, describe, expect, it, vi } from 'vitest';
import type { D1Database, D1ExecResult } from '@cloudflare/workers-types';
import type { CacheStore } from '../../src/core/types';
import { CacheUnavailableError } from '../../src/core/extension';
import { createCoordinatorCore, migrate } from '../../src/cloudflare/coordinator-core';
import { fenceD1Writes } from '../../src/d1/adapter';
import { createD1CacheRuntime, d1PrismaCacheExtension } from '../../src/d1/env';
import { d1CacheEpoch } from '../../src/d1/read';
import { memorySql } from './sqlite';

function setup() {
  const sql = memorySql();
  migrate(sql, sql.transact);
  const core = createCoordinatorCore(sql, () => crypto.randomUUID(), sql.transact);
  const inspect = () => core.inspectFences({ fences: ['g'], generation: '1' }, Date.now());
  const store: CacheStore = {
    beginWrite: async (request) => { core.beginWrite(request, Date.now()); },
    endWrite: async (request) => { core.endWrite(request, Date.now()); },
    invalidate: async () => { throw new Error('unused'); },
    read: async () => { throw new Error('unused'); },
    release: async () => { throw new Error('unused'); },
    write: async () => { throw new Error('unused'); },
  };
  return { core, inspect, store };
}

function fenced(store: CacheStore, operation: () => Promise<D1ExecResult>) {
  const unused = (): never => { throw new Error('unused'); };
  const db: D1Database = { exec: operation, prepare: unused, batch: unused, withSession: unused, dump: unused };
  return fenceD1Writes(db, { store, generation: '1', policy: { unfencedWriteTables: [] } });
}

afterEach(() => vi.useRealTimers());

describe('D1 write coordinator deadlines', () => {
  it('fails closed when begin hangs and cleans up a late successful begin', async () => {
    vi.useFakeTimers();
    const { core, inspect, store } = setup();
    const before = inspect();
    let resume: (() => void) | undefined;
    store.beginWrite = async (request) => {
      await new Promise<void>((resolve) => { resume = resolve; });
      core.beginWrite(request, Date.now());
    };
    const execute = vi.fn(async () => ({ count: 1, duration: 0 }));
    const result = fenced(store, execute).exec('UPDATE catalogue SET name = 1');
    const assertion = expect(result).rejects.toBeInstanceOf(CacheUnavailableError);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    expect(execute).not.toHaveBeenCalled();
    expect(inspect().pending).toBe(false);
    resume?.();
    await vi.advanceTimersByTimeAsync(0);
    const after = inspect();
    expect(after.pending).toBe(false);
    expect(after.epochs.g).toBeGreaterThan(before.epochs.g ?? 0);
  });

  it('returns the database result when end hangs and keeps the lease until the late end', async () => {
    vi.useFakeTimers();
    const { core, inspect, store } = setup();
    const before = inspect();
    let resume: (() => void) | undefined;
    store.endWrite = async (request) => {
      await new Promise<void>((resolve) => { resume = resolve; });
      core.endWrite(request, Date.now());
    };
    const value = { count: 1, duration: 4 };
    const result = fenced(store, async () => value).exec('UPDATE catalogue SET name = 1');
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toEqual(value);
    expect(inspect().pending).toBe(true);
    resume?.();
    await vi.advanceTimersByTimeAsync(0);
    const after = inspect();
    expect(after.pending).toBe(false);
    expect(after.epochs.g).toBeGreaterThan(before.epochs.g ?? 0);
  });

  it('ends the fence and invalidates even when the database write fails', async () => {
    const { inspect, store } = setup();
    const before = inspect();
    const failure = new Error('database failure');
    await expect(fenced(store, async () => { throw failure; }).exec('UPDATE catalogue SET name = 1')).rejects.toBe(failure);
    const after = inspect();
    expect(after.pending).toBe(false);
    expect(after.epochs.g).toBeGreaterThan(before.epochs.g ?? 0);
  });
});

const config = {
  cacheVersion: 'test', configFormat: 2, hasDecimalFields: false,
  cacheableByModel: { Post: true }, modelNames: ['Post'],
  primaryKeyFieldsByModel: { Post: ['id'] }, primaryKeyNameByModel: {}, relationGraph: {},
};
const profile = { unfencedWriteTables: [], readModels: ['Post'], envPrefix: 'CACHE', bindingNames: ['DB'], bindingPrefixes: [], coordinatorNamePrefix: 'test:', coordinatorClass: 'CacheCoordinator' };

it('captures a namespace only while the global fence is available and idle', async () => {
  const { core, store } = setup();
  store.inspectFences = async (request) => core.inspectFences(request, Date.now());
  const unused = (): never => { throw new Error('unused'); };
  const db: D1Database = { exec: async () => ({ count: 1, duration: 0 }), prepare: unused, batch: unused, withSession: unused, dump: unused };
  const wrapped = createD1CacheRuntime(db, { store, generation: '1', databaseId: 'db', profile });
  expect(await d1CacheEpoch(db)).toBeNull();
  const before = await d1CacheEpoch(wrapped);
  expect(before).not.toBeNull();
  await store.beginWrite({ fences: ['g'], generation: '1', leaseMs: 60000, token: 'pending' });
  expect(await d1CacheEpoch(wrapped)).toBeNull();
  await store.endWrite({ fences: ['g'], token: 'pending' });
  expect(await d1CacheEpoch(wrapped)).not.toBe(before);
  const unavailableStore = { ...store, inspectFences: async () => { throw new Error('unavailable'); } };
  const unavailable = createD1CacheRuntime(db, { store: unavailableStore, generation: '1', databaseId: 'db', profile });
  expect(await d1CacheEpoch(unavailable)).toBeNull();
});

function prismaExtension(store: CacheStore, scoped: boolean) {
  const unused = (): never => { throw new Error('unused'); };
  const db: D1Database = { exec: unused, prepare: unused, batch: unused, withSession: unused, dump: unused };
  const wrapped = createD1CacheRuntime(db, { store, generation: '1', databaseId: 'db', profile });
  const extension = d1PrismaCacheExtension(wrapped, config, scoped ? { scope: 'actor' } : undefined);
  if (!extension) throw new Error('missing extension');
  return extension;
}

function prismaWrite(extension: ReturnType<typeof prismaExtension>, query: () => Promise<unknown>) {
  return extension.query.$allModels.$allOperations({ model: 'Post', operation: 'update', args: { where: { id: 1 }, data: { title: 'new' } }, query });
}

describe.each([false, true])('Prisma D1 write coordinator deadlines (scoped=%s)', (scoped) => {
  it('rejects a hung begin without querying and cleans up its late lease', async () => {
    vi.useFakeTimers();
    const { core, store } = setup();
    const inspect = () => core.inspectFences({ fences: ['w:Post'], generation: '1' }, Date.now());
    const before = inspect();
    let resume: (() => void) | undefined;
    store.beginWrite = async (request) => {
      await new Promise<void>((resolve) => { resume = resolve; });
      core.beginWrite(request, Date.now());
    };
    const query = vi.fn(async () => ({ id: 1 }));
    const result = prismaWrite(prismaExtension(store, scoped), query);
    const assertion = expect(result).rejects.toBeInstanceOf(CacheUnavailableError);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    expect(query).not.toHaveBeenCalled();
    resume?.();
    await vi.advanceTimersByTimeAsync(0);
    const after = inspect();
    expect(after.pending).toBe(false);
    expect(after.epochs['w:Post']).toBeGreaterThan(before.epochs['w:Post'] ?? 0);
  });

  it('returns the actual result after a hung end and preserves the pending lease until late cleanup', async () => {
    vi.useFakeTimers();
    const { core, store } = setup();
    const inspect = () => core.inspectFences({ fences: ['w:Post'], generation: '1' }, Date.now());
    const before = inspect();
    let resume: (() => void) | undefined;
    store.endWrite = async (request) => {
      await new Promise<void>((resolve) => { resume = resolve; });
      core.endWrite(request, Date.now());
    };
    const value = { id: 1, title: 'new' };
    const result = prismaWrite(prismaExtension(store, scoped), async () => value);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toEqual(value);
    expect(inspect().pending).toBe(true);
    resume?.();
    await vi.advanceTimersByTimeAsync(0);
    const after = inspect();
    expect(after.pending).toBe(false);
    expect(after.epochs['w:Post']).toBeGreaterThan(before.epochs['w:Post'] ?? 0);
  });

  it('invalidates and propagates a failed write', async () => {
    const { core, store } = setup();
    const inspect = () => core.inspectFences({ fences: ['w:Post'], generation: '1' }, Date.now());
    const before = inspect();
    const failure = new Error('database failure');
    await expect(prismaWrite(prismaExtension(store, scoped), async () => { throw failure; })).rejects.toBe(failure);
    const after = inspect();
    expect(after.pending).toBe(false);
    expect(after.epochs['w:Post']).toBeGreaterThan(before.epochs['w:Post'] ?? 0);
  });
});

it('bounds exposed Prisma raw write and invalidate helpers', async () => {
  vi.useFakeTimers();
  const { store } = setup();
  store.beginWrite = () => new Promise<void>(() => undefined);
  store.invalidate = () => new Promise<void>(() => undefined);
  const extension = prismaExtension(store, false);
  const run = vi.fn(async () => 1);
  const raw = expect(extension.client.$cacheRawWrite({ all: true }, run)).rejects.toBeInstanceOf(CacheUnavailableError);
  const invalidation = expect(extension.client.$cacheInvalidate({ all: true })).rejects.toThrow('cache coordinator timeout');
  await vi.advanceTimersByTimeAsync(2_000);
  await Promise.all([raw, invalidation]);
  expect(run).not.toHaveBeenCalled();
});

it('unscoped Prisma reads fall back after a coordinator timeout and release a late miss lock', async () => {
  vi.useFakeTimers();
  const { core, store } = setup();
  let finishRead: (() => void) | undefined;
  let readStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { readStarted = resolve; });
  store.read = async (request) => {
    readStarted?.();
    await new Promise<void>((resolve) => { finishRead = resolve; });
    return core.read(request, Date.now());
  };
  const release = vi.fn(async (request: Parameters<CacheStore['release']>[0]) => { core.release(request); });
  store.release = release;
  const query = vi.fn(async () => [{ id: 1 }]);
  const result = prismaExtension(store, false).query.$allModels.$allOperations({ model: 'Post', operation: 'findMany', args: {}, query });
  await started;
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(result).resolves.toEqual([{ id: 1 }]);
  expect(query).toHaveBeenCalledTimes(1);
  finishRead?.();
  await vi.advanceTimersByTimeAsync(0);
  expect(release).toHaveBeenCalledOnce();
});

it('unscoped Prisma fill returns the database value when write and release hang', async () => {
  vi.useFakeTimers();
  const { core, store } = setup();
  store.read = async (request) => core.read(request, Date.now());
  let writeStarted: (() => void) | undefined;
  let releaseStarted: (() => void) | undefined;
  const writing = new Promise<void>((resolve) => { writeStarted = resolve; });
  const releasing = new Promise<void>((resolve) => { releaseStarted = resolve; });
  store.write = () => { writeStarted?.(); return new Promise(() => undefined); };
  store.release = () => { releaseStarted?.(); return new Promise(() => undefined); };
  const query = vi.fn(async () => [{ id: 1 }]);
  const result = prismaExtension(store, false).query.$allModels.$allOperations({ model: 'Post', operation: 'findMany', args: {}, query });
  await writing;
  await vi.advanceTimersByTimeAsync(2_000);
  await releasing;
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(result).resolves.toEqual([{ id: 1 }]);
  expect(query).toHaveBeenCalledTimes(1);
});

it('retries a failed D1 cleanup after the database operation and preserves its result', async () => {
  const { core, inspect, store } = setup();
  const before = inspect();
  let operationFinished = false;
  let attempts = 0;
  store.endWrite = async (request) => {
    expect(operationFinished).toBe(true);
    if (++attempts === 1) throw Error('temporary coordinator failure');
    core.endWrite(request, Date.now());
  };
  const value = { count:1, duration:0 };
  expect(await fenced(store, async () => { operationFinished = true; return value; }).exec('UPDATE catalogue SET name = 1')).toEqual(value);
  expect(attempts).toBe(2);
  expect(inspect().pending).toBe(false);
  expect(inspect().epochs.g).toBeGreaterThan(before.epochs.g ?? 0);
});

it('retries cleanup after a failed database operation and preserves its error', async () => {
  const { core, inspect, store } = setup();
  let attempts = 0;
  store.endWrite = async (request) => {
    if (++attempts === 1) throw Error('temporary coordinator failure');
    core.endWrite(request, Date.now());
  };
  const failure = new Error('database failure');
  await expect(fenced(store, async () => { throw failure; }).exec('UPDATE catalogue SET name = 1')).rejects.toBe(failure);
  expect(attempts).toBe(2);
  expect(inspect().pending).toBe(false);
});

it('retries late cleanup after an ambiguous begin without executing the write', async () => {
  vi.useFakeTimers();
  const { core, inspect, store } = setup();
  let resume: (() => void) | undefined;
  store.beginWrite = async (request) => {
    await new Promise<void>((resolve) => { resume = resolve; });
    core.beginWrite(request, Date.now());
  };
  let attempts = 0;
  store.endWrite = async (request) => {
    if (++attempts === 1) throw Error('temporary coordinator failure');
    core.endWrite(request, Date.now());
  };
  const execute = vi.fn(async () => ({ count:1, duration:0 }));
  const result = fenced(store, execute).exec('UPDATE catalogue SET name = 1');
  const assertion = expect(result).rejects.toBeInstanceOf(CacheUnavailableError);
  await vi.advanceTimersByTimeAsync(2000);
  await assertion;
  expect(execute).not.toHaveBeenCalled();
  resume?.();
  await vi.advanceTimersByTimeAsync(0);
  expect(attempts).toBe(2);
  expect(inspect().pending).toBe(false);
});

it('preserves the write result when all cleanup attempts fail', async () => {
  const { inspect, store } = setup();
  const end = vi.fn(async () => { throw Error('coordinator unavailable'); });
  store.endWrite = end;
  const value = { count:1, duration:0 };
  expect(await fenced(store, async () => value).exec('UPDATE catalogue SET name = 1')).toEqual(value);
  expect(end).toHaveBeenCalledTimes(2);
  expect(inspect().pending).toBe(true);
});

it('does not launch another cleanup after the shared deadline', async () => {
  vi.useFakeTimers();
  const { store } = setup();
  let rejectEnd: ((error: Error) => void) | undefined;
  const end = vi.fn(() => new Promise<void>((_, reject) => { rejectEnd = reject; }));
  store.endWrite = end;
  const value = { count:1, duration:0 };
  const result = fenced(store, async () => value).exec('UPDATE catalogue SET name = 1');
  await vi.advanceTimersByTimeAsync(2000);
  await expect(result).resolves.toEqual(value);
  rejectEnd?.(Error('late failure'));
  await vi.advanceTimersByTimeAsync(0);
  expect(end).toHaveBeenCalledTimes(1);
});

it('retains the lease until the database operation settles', async () => {
  const { inspect, store } = setup();
  let finish: (() => void) | undefined;
  let reached: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => { finish = resolve; });
  const started = new Promise<void>((resolve) => { reached = resolve; });
  const result = fenced(store, async () => { reached?.(); await waiting; return { count:1, duration:0 }; }).exec('UPDATE catalogue SET name = 1');
  await started;
  expect(inspect().pending).toBe(true);
  finish?.();
  await result;
  expect(inspect().pending).toBe(false);
});
