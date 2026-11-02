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
