import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { resolve } from 'node:path';

const source = `
import { cacheRegionalResponse } from './regional-response';
let loads = 0;
export default { async fetch(request) {
  return cacheRegionalResponse(request, { namespace:'test-deployment', ttlMs:5000 }, async () => new Response(JSON.stringify({ loads:++loads }), { headers:{ 'content-type':'application/json', 'cache-control':'public, max-age=0, s-maxage=5' } }));
} };`;

it('reuses an anonymous JSON response across HTTP invocations', async () => {
  const bundle = await build({ stdin:{ contents:source, resolveDir:resolve(__dirname, '../../src/d1'), loader:'ts' }, bundle:true, format:'esm', platform:'neutral', target:'es2022', external:['cloudflare:workers', 'node:async_hooks'], write:false });
  const output = bundle.outputFiles[0];
  if (!output) throw Error('bundle missing');
  const worker = new Miniflare({ modules:true, script:output.text, compatibilityDate:'2026-01-01', compatibilityFlags:['nodejs_compat'] });
  try {
    expect(await (await worker.dispatchFetch('https://a.test/data')).json()).toEqual({ loads:1 });
    const warm = await worker.dispatchFetch('https://a.test/data');
    expect(await warm.json()).toEqual({ loads:1 });
    expect(warm.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(await (await worker.dispatchFetch('https://a.test/data', { headers:{ Cookie:'session=x' } })).json()).toEqual({ loads:2 });
    expect(await (await worker.dispatchFetch('https://b.test/data')).json()).toEqual({ loads:3 });
    expect(await (await worker.dispatchFetch('https://a.test/data')).json()).toEqual({ loads:1 });
  } finally { await worker.dispose(); }
});

it('coalesces concurrent cold leases through native requests and separates credentials', async () => {
  const workerSource = `
import { wrapReadResponseLease, limitReadResponseLeaseUntil } from './http-response-lease';
let calls = 0, incoming = 0, released = false;
const handler = wrapReadResponseLease(async () => {
  const call = ++calls;
  while (!released) await new Promise(resolve => setTimeout(resolve, 5));
  limitReadResponseLeaseUntil(Date.now() + 5000);
  return Response.json({ call });
}, { namespace:'cold-native', deployment:'v1', database:'db', seconds:5, paths:['/items'], credentialHeaders:['cookie'], cookieNames:['session','fresh'], varyHeaders:[], freshnessCookie:'fresh', freshnessCookieMode:'generation' });
export default { fetch(request, env, ctx) {
  const path = new URL(request.url).pathname;
  if (path === '/state') return Response.json({ calls, incoming });
  if (path === '/release') { released = true; return new Response(null, { status:204 }); }
  incoming++;
  return handler(request, env, ctx);
} };`;
  const bundle = await build({ stdin:{ contents:workerSource, resolveDir:resolve(__dirname, '../../src'), loader:'ts' }, bundle:true, format:'esm', platform:'neutral', target:'es2022', external:['cloudflare:workers', 'node:async_hooks'], write:false });
  const output = bundle.outputFiles[0];
  if (!output) throw Error('bundle missing');
  const worker = new Miniflare({ modules:true, script:output.text, compatibilityDate:'2026-01-01', compatibilityFlags:['nodejs_compat'] });
  try {
    const state = async () => {
      const value: unknown = await (await worker.dispatchFetch('https://a.test/state')).json();
      if (!value || typeof value !== 'object' || !('calls' in value) || !('incoming' in value) || typeof value.calls !== 'number' || typeof value.incoming !== 'number') throw Error('invalid worker state');
      return { calls:value.calls, incoming:value.incoming };
    };
    const until = async (ready: (value: Awaited<ReturnType<typeof state>>) => boolean) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const value = await state();
        if (ready(value)) return value;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw Error('worker readiness not reached');
    };
    const first = worker.dispatchFetch('https://a.test/items', { headers:{ cookie:'session=a' } });
    await until((value) => value.calls === 1);
    const second = worker.dispatchFetch('https://a.test/items', { headers:{ cookie:'session=a' } });
    const held = await until((value) => value.incoming === 2);
    expect(held.calls).toBe(1);
    await worker.dispatchFetch('https://a.test/release');
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual([{ call:1 }, { call:1 }]);
    expect(await state()).toEqual({ calls:1, incoming:2 });
    const other = await worker.dispatchFetch('https://a.test/items', { headers:{ cookie:'session=b' } });
    expect(other.status).toBe(200);
    expect(await other.json()).toEqual({ call:2 });
  } finally { await worker.dispose(); }
});
