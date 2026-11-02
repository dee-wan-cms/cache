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
  const bundle = await build({ stdin:{ contents:source, resolveDir:resolve(__dirname, '../../src/d1'), loader:'ts' }, bundle:true, format:'esm', platform:'neutral', target:'es2022', external:['cloudflare:workers'], write:false });
  const output = bundle.outputFiles[0];
  if (!output) throw Error('bundle missing');
  const worker = new Miniflare({ modules:true, script:output.text, compatibilityDate:'2026-01-01' });
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
