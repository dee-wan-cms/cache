import { expect, it, vi } from 'vitest';
import { cacheReadValue } from '../../src/scoped-read';

function setup() {
  const entries = new Map<string, Response>();
  let time = 100_000;
  const cache: Pick<Cache, 'match' | 'put'> = {
    match: vi.fn(async (request) => entries.get(String(request))?.clone()),
    put: vi.fn(async (request, response) => { entries.set(String(request), response.clone()); }),
  };
  const options = { namespace:'app', key:{ actor:'alice' }, validate:(value: unknown): value is number => typeof value === 'number', cache, now:() => time };
  return { entries, cache, options, setTime:(value: number) => { time = value; } };
}

it('hits until five seconds and isolates scopes and namespaces', async () => {
  const { options, setTime } = setup();
  const load = vi.fn(async () => 1);
  expect(await cacheReadValue(options, load)).toBe(1);
  expect(await cacheReadValue(options, load)).toBe(1);
  expect(load).toHaveBeenCalledTimes(1);
  await cacheReadValue({ ...options, key:{ actor:'bob' } }, load);
  await cacheReadValue({ ...options, namespace:'other' }, load);
  expect(load).toHaveBeenCalledTimes(3);
  setTime(105_000);
  await cacheReadValue(options, load);
  expect(load).toHaveBeenCalledTimes(4);
});

it('rejects future, malformed, oversize and invalid cached values', async () => {
  const { entries, options } = setup();
  const load = vi.fn(async () => 1);
  await cacheReadValue(options, load);
  const key = [...entries.keys()][0];
  if (!key) throw new Error('missing cache key');
  for (const body of [
    '{',
    JSON.stringify({ started:100_001, expires:105_001, value:2 }),
    JSON.stringify({ started:100_000, expires:105_000, value:'invalid' }),
    'x'.repeat(256),
  ]) {
    entries.set(key, new Response(body));
    await cacheReadValue({ ...options, maxBytes:128 }, load);
  }
  for (const response of [
    new Response(JSON.stringify({ started:100_000, expires:105_000, value:2 }), { status:201 }),
    new Response(JSON.stringify({ started:100_000, expires:105_000, value:2 }), { headers:{ 'Set-Cookie':'session=secret' } }),
  ]) {
    entries.set(key, response);
    await cacheReadValue(options, load);
  }
  expect(load).toHaveBeenCalledTimes(7);
});

it('measures expiry from before loading and does not cache a slow fill', async () => {
  const { options, setTime, cache } = setup();
  await cacheReadValue(options, async () => { setTime(105_000); return 1; });
  expect(cache.put).not.toHaveBeenCalled();
  const load = vi.fn(async () => 2);
  expect(await cacheReadValue(options, load)).toBe(2);
  expect(load).toHaveBeenCalledOnce();
});

it('falls back on cache errors and never stores invalid source values', async () => {
  const { options, cache } = setup();
  vi.mocked(cache.match).mockRejectedValueOnce(new Error('read'));
  vi.mocked(cache.put).mockRejectedValueOnce(new Error('write'));
  expect(await cacheReadValue(options, async () => 1)).toBe(1);
  const invalid = { ...options, validate:(value: unknown): value is number => value === 0 };
  expect(await cacheReadValue(invalid, async () => 2)).toBe(2);
  expect(cache.put).toHaveBeenCalledTimes(1);
  await expect(cacheReadValue(options, async () => { throw new Error('source'); })).rejects.toThrow('source');
});

it('does not fill with an invalid source clock', async () => {
  for (const time of [NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER]) {
    const { options, cache } = setup();
    expect(await cacheReadValue({ ...options, now:() => time }, async () => 1)).toBe(1);
    expect(cache.put).not.toHaveBeenCalled();
  }
});


it('permits a longer lease only with an explicit bounded maximum', async () => {
  const { options, setTime } = setup();
  const load = vi.fn(async () => 1);
  await cacheReadValue({ ...options, ttlMs:300_000 }, load);
  await cacheReadValue({ ...options, ttlMs:300_000 }, load);
  expect(load).toHaveBeenCalledTimes(2);
  const extended = { ...options, ttlMs:300_000, maxTtlMs:300_000 };
  await cacheReadValue(extended, load);
  setTime(399_999);
  await cacheReadValue(extended, load);
  expect(load).toHaveBeenCalledTimes(3);
  setTime(400_000);
  await cacheReadValue(extended, load);
  expect(load).toHaveBeenCalledTimes(4);
});

it('bypasses caching for invalid maximums and TTLs', async () => {
  for (const [maxTtlMs, ttlMs] of [[0, 1], [300_001, 1], [1.5, 1], [100, 101], [100, 0], [100, 1.5]]) {
    const { options, cache } = setup();
    const load = vi.fn(async () => 1);
    await cacheReadValue({ ...options, maxTtlMs, ttlMs }, load);
    await cacheReadValue({ ...options, maxTtlMs, ttlMs }, load);
    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.match).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  }
});

it('returns a hit immediately, deduplicates refresh and renews from refresh start', async () => {
  const { options, setTime } = setup();
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const jobs: Promise<void>[] = [];
  const refreshLoad = vi.fn(async () => { started?.(); await held; return 2; });
  const refresh = { aheadMs:1000, waitUntil:(task: Promise<void>) => { jobs.push(task); }, load:refreshLoad };
  await cacheReadValue(options, async () => 1);
  setTime(104_001);
  expect(await cacheReadValue({ ...options, refresh }, async () => 9)).toBe(1);
  await ready;
  expect(await cacheReadValue({ ...options, refresh }, async () => 9)).toBe(1);
  expect(refreshLoad).toHaveBeenCalledOnce();
  setTime(104_100);
  release?.(); await Promise.all(jobs);
  setTime(109_000);
  expect(await cacheReadValue(options, async () => 9)).toBe(2);
  setTime(109_001);
  expect(await cacheReadValue(options, async () => 9)).toBe(9);
});

it('does not refresh when the host declines work or when refresh fails or returns invalid data', async () => {
  for (const mode of ['declined', 'error', 'invalid', 'late'] as const) {
    const { options, setTime } = setup();
    const jobs: Promise<void>[] = [];
    const load = vi.fn(async () => { if (mode === 'error') throw Error('source'); if (mode === 'late') setTime(110_000); return mode === 'invalid' ? NaN : 2; });
    const validate = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
    const refresh = { aheadMs:1000, waitUntil:(task: Promise<void>) => { if (mode === 'declined') throw Error('declined'); jobs.push(task); }, load };
    await cacheReadValue({ ...options, validate }, async () => 1);
    setTime(104_500);
    expect(await cacheReadValue({ ...options, validate, refresh }, async () => 9)).toBe(1);
    await Promise.all(jobs);
    if (mode === 'declined') { await Promise.resolve(); expect(load).not.toHaveBeenCalled(); }
    setTime(105_000);
    expect(await cacheReadValue({ ...options, validate }, async () => 9)).toBe(9);
  }
});

it('keeps refreshes isolated by key and cache instance', async () => {
  const a = setup(), b = setup();
  const jobs: Promise<void>[] = [];
  const load = vi.fn(async () => 2);
  const refresh = { aheadMs:1000, waitUntil:(task: Promise<void>) => { jobs.push(task); }, load };
  await cacheReadValue(a.options, async () => 1);
  await cacheReadValue({ ...a.options, key:'other' }, async () => 1);
  await cacheReadValue(b.options, async () => 1);
  a.setTime(104_500); b.setTime(104_500);
  await cacheReadValue({ ...a.options, refresh }, async () => 9);
  await cacheReadValue({ ...a.options, key:'other', refresh }, async () => 9);
  await cacheReadValue({ ...b.options, refresh }, async () => 9);
  await Promise.all(jobs);
  expect(load).toHaveBeenCalledTimes(3);
});

it('does not let a held refresh replace a newer foreground miss', async () => {
  const { options, setTime } = setup();
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const jobs: Promise<void>[] = [];
  const refresh = { aheadMs:1000, waitUntil:(task: Promise<void>) => { jobs.push(task); }, load:async () => { started?.(); await held; return 2; } };
  await cacheReadValue(options, async () => 1);
  setTime(104_500);
  await cacheReadValue({ ...options, refresh }, async () => 9);
  await ready;
  setTime(105_000);
  expect(await cacheReadValue(options, async () => 3)).toBe(3);
  release?.(); await Promise.all(jobs);
  expect(await cacheReadValue(options, async () => 9)).toBe(3);
});

it('orders a foreground fill after a refresh put already in progress', async () => {
  const base = setup();
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  let foregroundRead: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const readReady = new Promise<void>((resolve) => { foregroundRead = resolve; });
  let puts = 0, matches = 0;
  const cache: Pick<Cache, 'match' | 'put'> = {
    match:async (key) => { const response = await base.cache.match(key); if (++matches === 3) foregroundRead?.(); return response; },
    put:async (key, response) => {
      if (++puts === 2) { started?.(); await held; }
      await base.cache.put(key, response);
    },
  };
  const options = { ...base.options, cache };
  const jobs: Promise<void>[] = [];
  const refresh = { aheadMs:1000, waitUntil:(task: Promise<void>) => { jobs.push(task); }, load:async () => 2 };
  await cacheReadValue(options, async () => 1);
  base.setTime(104_500);
  await cacheReadValue({ ...options, refresh }, async () => 9);
  await ready;
  base.setTime(105_000);
  const foreground = cacheReadValue(options, async () => 3);
  await readReady;
  release?.();
  expect(await foreground).toBe(3);
  await Promise.all(jobs);
  expect(await cacheReadValue(options, async () => 9)).toBe(3);
});
