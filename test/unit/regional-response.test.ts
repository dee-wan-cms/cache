import { afterEach, expect, it, vi } from 'vitest';
import { cacheRegionalResponse } from '../../src/d1/regional-response';

const entries = new Map<string, Response>();
const cache = {
  match: vi.fn(async (key: string) => entries.get(key)?.clone()),
  put: vi.fn(async (key: string, response: Response) => { entries.set(key, response.clone()); }),
};
vi.stubGlobal('caches', { default:cache });
afterEach(() => { entries.clear(); vi.clearAllMocks(); vi.useRealTimers(); });
const options = { namespace:'deployment-1', ttlMs:5000 };
const request = (url = 'https://a.test/data', headers: Record<string, string> = {}) => new Request(url, { headers });
const origin = (value = 1) => new Response(JSON.stringify({ value }), { headers:{ 'content-type':'application/json', 'cache-control':'public, max-age=0, s-maxage=5', vary:'Origin' } });

it('reuses responses by host and origin until the fixed deadline', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  let loads = 0;
  const run = (req: Request) => cacheRegionalResponse(req, options, async () => origin(++loads));
  const a = request('https://a.test/data', { origin:'https://client-a.test' });
  expect(await (await run(a)).json()).toEqual({ value:1 });
  const warm = await run(a);
  expect(await warm.json()).toEqual({ value:1 });
  expect(warm.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
  expect(await (await run(request('https://b.test/data', { origin:'https://client-a.test' }))).json()).toEqual({ value:2 });
  expect(await (await run(request('https://a.test/data', { origin:'https://client-b.test' }))).json()).toEqual({ value:3 });
  vi.setSystemTime(105_000);
  expect(await (await run(a)).json()).toEqual({ value:4 });
});

it('bypasses credentials, preview, conditional and non-GET requests', async () => {
  const requests = [
    request('https://a.test/data', { cookie:'session=x' }), request('https://a.test/data', { authorization:'Bearer x' }),
    request('https://a.test/data', { 'proxy-authorization':'Basic x' }), request('https://a.test/data', { 'x-api-key':'x' }),
    request('https://a.test/data', { 'site-token':'x' }), request('https://a.test/data', { 'x-site-key':'x' }), request('https://a.test/data', { 'x-capability-token':'x' }),
    request('https://a.test/data', { 'x-preview':'1' }), request('https://a.test/data', { range:'bytes=0-1' }),
    request('https://a.test/data', { 'if-none-match':'x' }), request('https://a.test/data', { 'cache-control':'no-cache' }),
    request('https://a.test/data', { 'cache-control':'no-store' }), request('https://a.test/data?PREVIEW=1'),
    request('https://a.test/data?TOKEN=1'), request('https://a.test/data?CAPABILITY_TOKEN=1'), request('https://a.test/capabilities/x'),
    new Request('https://a.test/data', { method:'POST' }),
  ];
  for (const req of requests) {
    const response = origin();
    expect(await cacheRegionalResponse(req, options, async () => response)).toBe(response);
  }
  expect(cache.match).not.toHaveBeenCalled();
  expect(cache.put).not.toHaveBeenCalled();
});

it('rejects unsafe response headers, errors, corrupt entries and Cache API failures', async () => {
  const variants = [
    new Response('{}', { status:500, headers:{ 'content-type':'application/json', 'cache-control':'public, s-maxage=5' } }),
    new Response('{}', { headers:{ 'content-type':'application/json', 'cache-control':'private, s-maxage=5' } }),
    new Response('{}', { headers:{ 'content-type':'application/json', 'cache-control':'public, no-store, s-maxage=5' } }),
    new Response('{}', { headers:{ 'content-type':'application/json', 'cache-control':'public, s-maxage=5', 'set-cookie':'x=y' } }),
    new Response('{}', { headers:{ 'content-type':'application/json', 'cache-control':'public, s-maxage=5', vary:'Cookie' } }),
    new Response('broken', { headers:{ 'content-type':'application/json', 'cache-control':'public, s-maxage=5' } }),
  ];
  for (const response of variants) expect(await cacheRegionalResponse(request(), options, async () => response)).toBe(response);
  expect(cache.put).not.toHaveBeenCalled();
  await expect(cacheRegionalResponse(request(), options, async () => { throw Error('source'); })).rejects.toThrow('source');
  cache.match.mockRejectedValueOnce(Error('cache down'));
  cache.put.mockRejectedValueOnce(Error('cache down'));
  expect(await (await cacheRegionalResponse(request(), options, async () => origin())).json()).toEqual({ value:1 });
  await cacheRegionalResponse(request(), options, async () => origin(2));
  for (const key of entries.keys()) entries.set(key, new Response('invalid'));
  expect(await (await cacheRegionalResponse(request(), options, async () => origin(3))).json()).toEqual({ value:3 });
});

it('does not promote an expired slow fill over a newer response', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { started = resolve; });
  const slow = cacheRegionalResponse(request(), options, async () => { started?.(); await paused; return origin(1); });
  await reached;
  vi.setSystemTime(104_000);
  expect(await (await cacheRegionalResponse(request(), options, async () => origin(2))).json()).toEqual({ value:2 });
  vi.setSystemTime(105_000); release?.();
  expect(await (await slow).json()).toEqual({ value:1 });
  expect(await (await cacheRegionalResponse(request(), options, async () => origin(3))).json()).toEqual({ value:2 });
});

it('honors a shorter shared lifetime and namespaces', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  let loads = 0;
  const load = async () => new Response(JSON.stringify({ value:++loads }), { headers:{ 'content-type':'application/json', 'cache-control':'public, s-maxage=1' } });
  expect(await (await cacheRegionalResponse(request(), options, load)).json()).toEqual({ value:1 });
  expect(await (await cacheRegionalResponse(request(), { ...options, namespace:'deployment-2' }, load)).json()).toEqual({ value:2 });
  vi.setSystemTime(101_000);
  expect(await (await cacheRegionalResponse(request(), options, load)).json()).toEqual({ value:3 });
});
