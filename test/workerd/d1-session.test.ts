import { afterAll, beforeAll, expect, it } from 'vitest';
import { startRig, type Rig } from './rig';

let rig: Rig;
beforeAll(async () => { rig = await startRig(); });
afterAll(async () => { await rig.dispose(); });

it('reuses a Prisma WASM client across mutation, anchored read and a physical alias', async () => {
  await rig.reset();
  const write = await rig.session('session-user', { method:'POST' });
  expect(write.status, await write.clone().text()).toBe(200);
  const bookmark = write.headers.get('X-Dee-Wan-D1-Bookmarks');
  expect(bookmark).toBeTruthy();
  const read = await rig.session('session-user', { headers:{ 'X-Dee-Wan-D1-Bookmarks':bookmark ?? '' } });
  expect(read.status, await read.clone().text()).toBe(200);
  const result = await read.json() as { rows:Array<{ name:string }>; alias:{ total:number }; clientCount:number; cacheHits:number };
  expect(result.rows.map((row) => row.name)).toEqual(['session-user']);
  expect(result.alias.total).toBe(1);
  expect(result.clientCount).toBe(1);
  expect(result.cacheHits).toBeGreaterThan(0);
  expect(read.headers.get('X-Dee-Wan-D1-Bookmarks')).toBeTruthy();
});

it('keeps concurrent tenant-filtered Prisma operations isolated', async () => {
  await rig.reset();
  const responses = await Promise.all(['tenant-a', 'tenant-b'].map((name) => rig.session(name, { method:'POST' })));
  for (let i = 0; i < responses.length; i++) {
    const response = responses[i];
    expect(response?.status).toBe(200);
    const result = await response?.json() as { rows:Array<{ name:string }>; alias:{ total:number }; clientCount:number; cacheHits:number };
    expect(result.rows.map((row) => row.name)).toEqual([['tenant-a', 'tenant-b'][i]]);
    expect(result.alias.total).toBe(1);
    expect(result.clientCount).toBe(1);
  }
});

it('runs a Prisma array transaction through one admission group', async () => {
  await rig.reset();
  await rig.session('batch-user', { method:'POST' });
  const response = await rig.sessionBatch('batch-user');
  expect(response.status, await response.clone().text()).toBe(200);
  const result = await response.json() as { batch:[Array<{ name:string }>, number] };
  expect(result.batch[0].map((row) => row.name)).toEqual(['batch-user']);
  expect(result.batch[1]).toBe(1);
});

it('preserves WebSocket upgrades without opening a D1 session', async () => {
  const { build } = await import('esbuild');
  const { Miniflare } = await import('miniflare');
  const { resolve } = await import('node:path');
  const source = `
import { wrapD1ReadSessionHandler } from './session';
const handler = wrapD1ReadSessionHandler(async () => {
  const pair = new WebSocketPair();
  pair[1].accept();
  return new Response(null, { status:101, webSocket:pair[0] });
}, { bindingNames:['DB'], bindingPrefixes:[], databaseIdsEnv:'IDS' });
export default { fetch:handler };
`;
  const bundle = await build({ stdin:{ contents:source, resolveDir:resolve(__dirname, '../../src/d1'), loader:'ts' }, bundle:true, format:'esm', platform:'neutral', target:'es2022', external:['node:async_hooks'], write:false });
  const output = bundle.outputFiles[0];
  if (!output) throw new Error('missing worker bundle');
  const worker = new Miniflare({ modules:true, script:output.text, compatibilityDate:'2026-01-01', compatibilityFlags:['nodejs_compat'], bindings:{ IDS:'invalid' } });
  try {
    const response = await worker.dispatchFetch('http://cache.test/socket', { headers:{ upgrade:'websocket' } });
    expect(response.status).toBe(101);
    expect(response.webSocket).toBeTruthy();
    response.webSocket?.accept();
    response.webSocket?.close();
  } finally { await worker.dispose(); }
});
