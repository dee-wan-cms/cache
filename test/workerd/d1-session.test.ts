import { afterAll, beforeAll, expect, it } from 'vitest';
import { startRig, until, type Rig } from './rig';

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

it('completes scoped reads and writes while a coordinator write fence is pending', async () => {
  await rig.reset();
  expect((await rig.session('race-reader', { method:'POST' })).status).toBe(200);
  const response = await rig.sessionPendingWriteRace();
  expect(response.status, await response.clone().text()).toBe(200);
  const result = await response.json() as { read:{ rows:Array<{ name:string }> }; write:{ written:boolean }; readBookmark:string; writeBookmark:string };
  expect(result.read.rows.map((row) => row.name)).toEqual(['race-reader']);
  expect(result.write.written).toBe(true);
  expect(result.readBookmark).toBeTruthy();
  expect(result.writeBookmark).toBeTruthy();
  const check = await rig.session('race-writer');
  const body = await check.json() as { rows:Array<{ name:string }> };
  expect(body.rows.map((row) => row.name)).toEqual(['race-writer']);
});

it('isolates concurrent cached unique and first reads on one Prisma client', async () => {
  await rig.reset();
  for (const name of ['unique-a', 'unique-b']) expect((await rig.session(name, { method:'POST' })).status).toBe(200);
  for (const name of ['unique-a', 'unique-b']) expect((await rig.sessionUnique(name, true)).status).toBe(200);
  const before = await (await rig.sessionUnique('unique-a', true)).json() as { cacheHits:number };
  let highestHits = before.cacheHits;
  for (let wave = 0; wave < 2; wave++) {
    const names = ['unique-a', 'unique-b', 'unique-a', 'unique-b'];
    const responses = await Promise.all(names.map((name) => rig.sessionUnique(name)));
    for (const [index, response] of responses.entries()) {
      expect(response.status, await response.clone().text()).toBe(200);
      const result = await response.json() as { unique:{ name:string }; first:{ name:string }; clientCount:number; cacheHits:number };
      expect(result.unique.name).toBe(names[index]);
      expect(result.first.name).toBe(names[index]);
      expect(result.clientCount).toBe(1);
      highestHits = Math.max(highestHits, result.cacheHits);
      expect(response.headers.get('X-Dee-Wan-D1-Bookmarks')).toBeTruthy();
    }
  }
  expect(highestHits).toBeGreaterThan(before.cacheHits);
});

it('completes a mutation while same-isolate response warming holds a Prisma read', async () => {
  await rig.reset();
  expect((await rig.session('race-reader', { method:'POST' })).status).toBe(200);
  const response = await rig.sessionWarmWriteRace();
  expect(response.status, await response.clone().text()).toBe(200);
  const result = await response.json() as { status:number; body:{ written:boolean }; bookmark:string };
  expect(result.status).toBe(200);
  expect(result.body.written).toBe(true);
  expect(result.bookmark).toBeTruthy();
  const check = await rig.session('warm-writer');
  const body = await check.json() as { rows:Array<{ name:string }> };
  expect(body.rows.map((row) => row.name)).toEqual(['warm-writer']);
});

it('keeps an aborted warm source alive until its Prisma admission is released', async () => {
  await rig.reset();
  expect((await rig.session('race-reader', { method:'POST' })).status).toBe(200);
  expect((await rig.warmAbort('trigger')).status).toBe(200);
  const status = async () => await (await rig.warmAbort('status')).json() as { entered:boolean; batchDone:boolean };
  try {
    await until(status, (value) => value.entered, 'warm Prisma read admitted');
    expect((await rig.warmAbort('cancel', 'POST')).status).toBe(200);
    await until(status, (value) => value.batchDone, 'aborted warm batch finished');
  } finally {
    await rig.warmAbort('release', 'POST');
  }
  const write = await rig.warmAbort('write', 'POST');
  expect(write.status, await write.clone().text()).toBe(200);
  expect(await write.json()).toEqual({ written:true });
  expect(write.headers.get('X-Dee-Wan-D1-Bookmarks')).toBeTruthy();
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
