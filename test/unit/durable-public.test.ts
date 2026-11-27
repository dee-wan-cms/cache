import { afterEach, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { bootstrapPublicNamespace, readPublicNamespaceIdentity, attachPublicGeneration, cancelPublicMutation, createDurablePublicStore, createPublicReadViews, createPublicSiteFence, finishPublicMutation, publicHostReady, publicHostRetired, recoverPublicMutation, reservePublicMutation, type DurableAuthority } from '../../src/cloudflare/durable-public';

let worker: Miniflare | undefined;
afterEach(async () => { await worker?.dispose(); worker = undefined; });

it('starts the owned read with the namespace check and cancels it when authority is unavailable', async () => {
  worker = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', r2Buckets: ['PUBLIC'] });
  const bucket = await worker.getR2Bucket('PUBLIC');
  expect(await bootstrapPublicNamespace(bucket as never, 'parallel/', 'initial')).toBe(true);
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let requested = false;
  const delayed = new Proxy(bucket, { get(target, property, receiver) {
    if (property !== 'get') return Reflect.get(target, property, receiver);
    return async (key: string) => {
      if (key === 'parallel/bootstrap') await gate;
      else requested = true;
      return target.get(key);
    };
  } });
  const reading = createDurablePublicStore(delayed as never, 'parallel/').readAuthority('missing.test');
  await vi.waitFor(() => expect(requested).toBe(true));
  release();
  expect(await reading).toBeNull();

  await bucket.put('absent/authority/example.test', '{}');
  let cancelled = false;
  const unready = new Proxy(bucket, { get(target, property, receiver) {
    if (property !== 'get') return Reflect.get(target, property, receiver);
    return async (key: string) => {
      const object = await target.get(key);
      if (!object || key.endsWith('/bootstrap')) return object;
      return new Proxy(object, { get(value, field, objectReceiver) {
        if (field !== 'body') return Reflect.get(value, field, objectReceiver);
        return { cancel: async () => { cancelled = true; await value.body.cancel(); } };
      } });
    };
  } });
  await expect(createDurablePublicStore(unready as never, 'absent/').readAuthority('example.test')).rejects.toThrow('namespace is not initialized');
  expect(cancelled).toBe(true);
  cancelled = false;
  const failed = new Proxy(unready, { get(target, property, receiver) {
    if (property !== 'get') return Reflect.get(target, property, receiver);
    return async (key: string) => {
      if (key.endsWith('/bootstrap')) throw new Error('marker unavailable');
      return target.get(key);
    };
  } });
  await expect(createDurablePublicStore(failed as never, 'absent/').readAuthority('example.test')).rejects.toThrow('marker unavailable');
  expect(cancelled).toBe(true);
});

it('initializes only an empty namespace and safely reconciles concurrent bootstrap', async () => {
  worker = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', r2Buckets: ['PUBLIC', 'OTHER'] });
  const bucket = await worker.getR2Bucket('PUBLIC');
  await bucket.put('occupied/unowned', 'existing');
  expect(await bootstrapPublicNamespace(bucket as never, 'occupied/', 'initial')).toBe(false);
  expect(await bucket.get('occupied/unowned')).not.toBeNull();
  const results = await Promise.all([
    bootstrapPublicNamespace(bucket as never, 'empty/', 'initial'),
    bootstrapPublicNamespace(bucket as never, 'empty/', 'initial'),
  ]);
  expect(results).toEqual([true, true]);
  expect(await bootstrapPublicNamespace(bucket as never, 'empty/', 'other')).toBe(false);
  expect(await bootstrapPublicNamespace(bucket as never, 'empty/', 'initial')).toBe(true);
  const identity = await readPublicNamespaceIdentity(bucket as never, 'empty/');
  const other = await worker.getR2Bucket('OTHER');
  expect(await bootstrapPublicNamespace(other as never, 'empty/', 'initial')).toBe(true);
  expect(await readPublicNamespaceIdentity(other as never, 'empty/')).not.toEqual(identity);
  expect(await readPublicNamespaceIdentity(bucket as never, 'empty/')).toEqual(identity);
});

it('uses R2 conditional writes to fence stale publication and withdrawal owners', async () => {
  worker = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', r2Buckets: ['PUBLIC'] });
  const bucket = await worker.getR2Bucket('PUBLIC');
  expect(await bootstrapPublicNamespace(bucket as never, 'installation-a/', 'initial')).toBe(true);
  const store = createDurablePublicStore(bucket as never, 'installation-a/');
  const initial: DurableAuthority = { format: 1, host: 'example.test', site: 'site-a', revision: 'r1', generationFence: 1, capture: {'00000000-0000-4000-8000-000000000001': { operation: 'fixture', sequence: 1 }}, tenantSource: 'tenant-a', policy: 'p1', contract: 'v1', state: 'active', operation: 'initial', markerSource: 'source-a', fence: 1, markerFence: 1, previousPublication: null, intent: null, previousState: null, origins: [], responses: [], candidate: null, rollback: [] };
  expect(await store.compareAndSetAuthority(initial, null)).toBe(true);
  expect(await store.compareAndSetAuthority(initial, null)).toBe(false);
  const first = await store.readAuthority(initial.host);
  expect(first).not.toBeNull();
  if (!first) throw new Error('Missing initial authority');
  const publication = { revision: 'r2', generationFence: 1, capture: {'00000000-0000-4000-8000-000000000001': { operation: 'fixture', sequence: 1 }}, tenantSource: 'tenant-a', policy: 'p1', contract: 'v1', state: 'active' as const, origins: [], responses: [] };
  const denied = { ...publication, policy: 'p2', state: 'denied' as const };
  const [a, b] = await Promise.all([reservePublicMutation(store, first, 'a', 'publish', 'source-a'), reservePublicMutation(store, first, 'b', 'publish', 'source-a')]);
  expect([a, b].filter(Boolean)).toHaveLength(1);
  const winner = a ?? b;
  if (!winner) throw new Error('Missing reservation');
  expect((await store.readAuthority(initial.host))?.value.state).toBe('active');
  expect(await recoverPublicMutation(store, { host: initial.host, site: 'site-a', operation: winner.value.operation, markerSource: 'source-a', fence: winner.value.fence })).not.toBeNull();
  expect(await recoverPublicMutation(store, { host: initial.host, site: 'site-a', operation: winner.value.operation, markerSource: 'source-a', fence: winner.value.fence - 1 })).toBeNull();
  const prepared = await attachPublicGeneration(store, winner, { ...publication, generationFence: winner.value.markerFence });
  if (!prepared) throw new Error('Missing prepared generation');
  expect(await finishPublicMutation(store, prepared)).toBe(true);
  const current = await store.readAuthority(initial.host);
  if (!current) throw new Error('Missing active authority');
  const withdrawal = await reservePublicMutation(store, current, 'withdrawal', 'withdraw', 'source-a');
  if (!withdrawal) throw new Error('Missing withdrawal');
  expect((await store.readAuthority(initial.host))?.value.state).toBe('pending');
  expect(await finishPublicMutation(store, prepared)).toBe(false);
  const withdrawn = await attachPublicGeneration(store, withdrawal, { ...denied, generationFence: withdrawal.value.markerFence });
  if (!withdrawn) throw new Error('Missing prepared withdrawal');
  expect(await finishPublicMutation(store, withdrawn)).toBe(true);
  expect((await store.readAuthority(initial.host))?.value.state).toBe('denied');
  const settled = await recoverPublicMutation(store, { host: initial.host, site: 'site-a', operation: 'withdrawal', markerSource: 'source-a', fence: withdrawal.value.fence });
  expect(settled?.value.intent).toBeNull();
  expect(settled?.value.state).toBe('denied');
  if (!settled) throw new Error('Missing settled authority');
  expect(await reservePublicMutation(store, settled, 'withdrawal', 'withdraw', 'source-a')).toBeNull();
  expect(await store.readAuthority('other.test')).toBeNull();
});


it('keeps immutable bounded bytes and rejects corrupted content', async () => {
  worker = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', r2Buckets: ['PUBLIC'] });
  const bucket = await worker.getR2Bucket('PUBLIC');
  expect(await bootstrapPublicNamespace(bucket as never, 'installation-a/', 'initial')).toBe(true);
  const store = createDurablePublicStore(bucket as never, 'installation-a/');
  const bytes = new TextEncoder().encode('{"data":[]}');
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const objectKey = await store.putResponse('site-a', 'op-a', 1, digest, bytes, 100);
  expect(await store.putResponse('site-a', 'op-a', 1, digest, bytes, 100)).toBe(objectKey);
  expect(await store.readResponse('site-a', objectKey, digest, 100)).toEqual(bytes);
  await expect(store.readResponse('site-a', objectKey, digest, 2)).rejects.toThrow('size');
  await bucket.put(`installation-a/responses/${objectKey}`, 'corrupt');
  await expect(store.readResponse('site-a', objectKey, digest, 100)).rejects.toThrow('digest');
});

it('preempts a stranded publication with a withdrawal and fences the old owner', async () => {
  worker = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', r2Buckets: ['PUBLIC'] });
  const bucket = await worker.getR2Bucket('PUBLIC');
  expect(await bootstrapPublicNamespace(bucket as never, 'installation-a/', 'initial')).toBe(true);
  const store = createDurablePublicStore(bucket as never, 'installation-a/');
  const initial: DurableAuthority = { format: 1, host: 'example.test', site: 'site-a', revision: 'r1', generationFence: 1, capture: {'00000000-0000-4000-8000-000000000001': { operation: 'fixture', sequence: 1 }}, tenantSource: 'tenant-a', policy: 'p1', contract: 'v1', state: 'active', operation: 'initial', markerSource: 'source-a', fence: 1, markerFence: 1, previousPublication: null, intent: null, previousState: null, origins: [], responses: [], candidate: null, rollback: [] };
  await store.compareAndSetAuthority(initial, null);
  const current = await store.readAuthority(initial.host);
  if (!current) throw new Error('Missing authority');
  const publish = await reservePublicMutation(store, current, 'stuck-publish', 'publish', 'source-a');
  if (!publish) throw new Error('Missing publication reservation');
  const withdrawal = await reservePublicMutation(store, publish, 'withdraw', 'withdraw', 'source-a');
  if (!withdrawal) throw new Error('Missing withdrawal reservation');
  expect(withdrawal.value.state).toBe('pending');
  expect(withdrawal.value.previousState).toBe('active');
  expect(await attachPublicGeneration(store, publish, { revision: 'r2', generationFence: 1, capture: {'00000000-0000-4000-8000-000000000001': { operation: 'fixture', sequence: 1 }}, tenantSource: 'tenant-a', policy: 'p1', contract: 'v1', state: 'active', origins: [], responses: [] })).toBeNull();
  expect(await recoverPublicMutation(store, { host: initial.host, site: initial.site, operation: 'stuck-publish', markerSource: 'source-a', fence: publish.value.fence })).toBeNull();
  expect(await cancelPublicMutation(store, withdrawal)).toBe(true);
  const restored = await store.readAuthority(initial.host);
  expect(restored?.value.intent).toBe('publish');
  expect(restored?.value.operation).toBe('stuck-publish');
  expect(restored?.value.markerFence).toBe(publish.value.fence);
  expect(restored?.value.fence).toBe(withdrawal.value.fence);
  expect(restored?.value.state).toBe('active');
});


it('serializes site-specific writer and GC ownership without expiring a held fence', async () => {
  worker = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', r2Buckets: ['PUBLIC'] });
  const bucket = await worker.getR2Bucket('PUBLIC');
  expect(await bootstrapPublicNamespace(bucket as never, 'installation-a/', 'initial')).toBe(true);
  const fences = createPublicSiteFence(bucket as never, 'installation-a/');
  const [writer, gc] = await Promise.all([fences.acquire('site-a', 'op-a', 'writer-a', 'writer'), fences.acquire('site-a', 'op-gc', 'gc-a', 'gc')]);
  expect([writer, gc].filter(Boolean)).toHaveLength(1);
  const held = writer ?? gc;
  if (!held) throw new Error('Missing fence');
  expect(await fences.acquire('site-a', held.value.operation, held.value.owner, held.value.kind)).toBeNull();
  expect(await fences.acquire('site-b', 'op-b', 'other', 'writer')).not.toBeNull();
  const takeover = await fences.takeover(held, 'replacement');
  if (!takeover) throw new Error('Missing takeover');
  expect(await fences.release(held)).toBe(false);
  expect(takeover.value.operation).toBe(held.value.operation);
  let released = takeover;
  if (takeover.value.kind === 'gc') {
    const planned = await fences.planGcPage(takeover);
    if (!planned) throw new Error('Missing GC plan');
    const applied = await fences.applyGcPage(planned);
    if (!applied) throw new Error('Missing GC completion');
    released = applied;
  }
  expect(await fences.release(released)).toBe(true);
  const next = await fences.acquire('site-a', 'op-next', 'next', 'writer');
  expect(next?.value.fence).toBe(takeover.value.fence + 1);
  expect(await fences.release(held)).toBe(false);
});

it('blocks GC while a registered host operation remains uncertain', async () => {
  worker = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', r2Buckets: ['PUBLIC'] });
  const bucket = await worker.getR2Bucket('PUBLIC');
  expect(await bootstrapPublicNamespace(bucket as never, 'installation-a/', 'initial')).toBe(true);
  const store = createDurablePublicStore(bucket as never, 'installation-a/');
  const fences = createPublicSiteFence(bucket as never, 'installation-a/');
  const held = await fences.acquire('site-a', 'op-a', 'writer', 'writer');
  if (!held) throw new Error('Missing writer');
  const hosts = await fences.registerHosts(held, ['example.test']);
  if (!hosts) throw new Error('Missing host');
  const initial: DurableAuthority = { format: 1, host: 'example.test', site: 'site-a', revision: 'r1', generationFence: 1, capture: {'00000000-0000-4000-8000-000000000001': { operation: 'fixture', sequence: 1 }}, tenantSource: 't', policy: 'p', contract: 'v', state: 'active', operation: 'initial', markerSource: 'source', fence: 1, markerFence: 1, previousPublication: null, intent: null, previousState: null, origins: [], responses: [], candidate: null, rollback: [] };
  await store.compareAndSetAuthority(initial, null);
  const authority = await store.readAuthority('example.test');
  if (!authority) throw new Error('Missing authority');
  const intent = { host: 'example.test', operation: 'op-a', markerSource: 'source', markerFence: 2 };
  const registered = await fences.registerIntent(hosts, intent);
  if (!registered) throw new Error('Missing intent');
  expect(await fences.cancelIntent(registered, intent, authority)).toBeNull();
  expect(await fences.release(registered)).toBe(true);
  expect(await fences.acquire('site-a', 'gc', 'collector', 'gc')).toBeNull();
});

it('keeps generation references across fence takeover and rejects another site', async () => {
  worker = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', r2Buckets: ['PUBLIC'] });
  const bucket = await worker.getR2Bucket('PUBLIC');
  expect(await bootstrapPublicNamespace(bucket as never, 'installation-a/', 'initial')).toBe(true);
  const fences = createPublicSiteFence(bucket as never, 'installation-a/');
  const held = await fences.acquire('site-a', 'op-a', 'writer-a', 'writer');
  if (!held) throw new Error('Missing fence');
  const hosts = await fences.registerHosts(held, ['example.test']);
  if (!hosts) throw new Error('Missing host');
  const store = createDurablePublicStore(bucket as never, 'installation-a/');
  const authority: DurableAuthority = { format: 1, host: 'example.test', site: 'site-a', revision: 'r1', generationFence: 1, capture: {'00000000-0000-4000-8000-000000000001': { operation: 'fixture', sequence: 1 }}, tenantSource: 'tenant-a', policy: 'p1', contract: 'v1', state: 'active', operation: 'initial', markerSource: 'source-a', fence: 1, markerFence: 1, previousPublication: null, intent: null, previousState: null, origins: [], responses: [], candidate: null, rollback: [] };
  await store.compareAndSetAuthority(authority, null);
  const actual = await store.readAuthority(authority.host);
  if (!actual) throw new Error('Missing authority');
  const digest = 'a'.repeat(64);
  const key = `site-a/op-a/${held.value.fence}/${digest}`;
  await bucket.put(`installation-a/responses/${key}`, '{}');
  const generation = { revision: 'r1', generationFence: 1, capture: {'00000000-0000-4000-8000-000000000001': { operation: 'fixture', sequence: 1 }}, tenantSource: 'tenant-a', policy: 'p1', contract: 'v1', state: 'active' as const, origins: [], responses: [{ target: '/v1/posts', digest, objectKey: key }] };
  const response = generation.responses[0];
  if (!response) throw new Error('Missing response');
  expect(await fences.registerGeneration(hosts, { ...generation, responses: [{ ...response, objectKey: `site-b/op-a/1/${digest}` }] }, actual)).toBeNull();
  const pinned = await fences.registerGeneration(hosts, generation, actual);
  if (!pinned) throw new Error('Missing registered generation');
  expect(pinned.value.pins).toEqual([key]);
  expect(await fences.registerGeneration(hosts, generation, actual)).toBeNull();
  const takeover = await fences.takeover(pinned, 'writer-b');
  expect(takeover?.value.pins).toEqual([key]);
  if (!takeover) throw new Error('Missing takeover');
  expect(await publicHostReady(store, fences, authority.host, [], async () => true, 100)).toBe(false);
  expect(await fences.release(takeover)).toBe(true);
  expect(await publicHostReady(store, fences, authority.host, [], async () => true, 100)).toBe(true);
  const remote = createPublicReadViews(async (key, limit) => {
    const object = await bucket.get(key);
    if (!object || object.size > limit) return null;
    return { bytes: new Uint8Array(await object.arrayBuffer()), etag: object.etag };
  }, 'installation-a/');
  expect(await publicHostReady(remote.store, remote.fences, authority.host, [], async () => true, 100)).toBe(true);
  expect(await publicHostReady(store, fences, authority.host, ['/v1/posts'], async () => true, 100)).toBe(false);
  expect(await publicHostRetired(store, fences, authority.host, async () => true)).toBe(false);
});

it('freezes GC deletion before takeover and retains pinned and newer objects', async () => {
  worker = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', r2Buckets: ['PUBLIC'] });
  const bucket = await worker.getR2Bucket('PUBLIC');
  expect(await bootstrapPublicNamespace(bucket as never, 'installation-a/', 'initial')).toBe(true);
  const fences = createPublicSiteFence(bucket as never, 'installation-a/');
  const writer = await fences.acquire('site-a', 'op-a', 'writer', 'writer');
  if (!writer) throw new Error('Missing writer');
  const hosts = await fences.registerHosts(writer, ['example.test']);
  if (!hosts) throw new Error('Missing host');
  const store = createDurablePublicStore(bucket as never, 'installation-a/');
  const authority: DurableAuthority = { format: 1, host: 'example.test', site: 'site-a', revision: 'r1', generationFence: 1, capture: {'00000000-0000-4000-8000-000000000001': { operation: 'fixture', sequence: 1 }}, tenantSource: 't', policy: 'p', contract: 'v', state: 'active', operation: 'initial', markerSource: 'source-a', fence: 1, markerFence: 1, previousPublication: null, intent: null, previousState: null, origins: [], responses: [], candidate: null, rollback: [] };
  await store.compareAndSetAuthority(authority, null);
  const actual = await store.readAuthority(authority.host);
  if (!actual) throw new Error('Missing authority');
  const digest = 'a'.repeat(64);
  const pinnedKey = `site-a/op-a/${writer.value.fence}/${digest}`;
  const orphanKey = `site-a/op-old/${writer.value.fence}/${'b'.repeat(64)}`;
  await bucket.put(`installation-a/responses/${pinnedKey}`, '{}');
  await bucket.put(`installation-a/responses/${orphanKey}`, '{}');
  const pinned = await fences.registerGeneration(hosts, { revision: 'r1', generationFence: 1, capture: {'00000000-0000-4000-8000-000000000001': { operation: 'fixture', sequence: 1 }}, tenantSource: 't', policy: 'p', contract: 'v', state: 'active', origins: [], responses: [{ target: '/v1/posts', digest, objectKey: pinnedKey }] }, actual);
  if (!pinned || !await fences.release(pinned)) throw new Error('Cannot release writer');
  const gc = await fences.acquire('site-a', 'gc', 'gc-a', 'gc');
  if (!gc) throw new Error('Missing GC');
  const planned = await fences.planGcPage(gc);
  if (!planned) throw new Error('Missing GC plan');
  expect(planned.value.gcPlan).toEqual([orphanKey]);
  const takeover = await fences.takeover(planned, 'gc-b');
  if (!takeover) throw new Error('Missing takeover');
  const applied = await fences.applyGcPage(takeover);
  if (!applied || !await fences.release(applied)) throw new Error('Cannot finish GC');
  const next = await fences.acquire('site-a', 'op-new', 'writer-new', 'writer');
  if (!next) throw new Error('Missing new writer');
  const newKey = `site-a/op-new/${next.value.fence}/${'c'.repeat(64)}`;
  await bucket.put(`installation-a/responses/${newKey}`, '{}');
  expect(await fences.applyGcPage(planned)).toBeNull();
  expect(await bucket.get(`installation-a/responses/${newKey}`)).not.toBeNull();
  expect(await bucket.get(`installation-a/responses/${pinnedKey}`)).not.toBeNull();
  expect(await bucket.get(`installation-a/responses/${orphanKey}`)).toBeNull();
});

it('refuses rollback when a retained negative response differs from current public output', async () => {
  worker = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', r2Buckets: ['PUBLIC'] });
  const bucket = await worker.getR2Bucket('PUBLIC');
  expect(await bootstrapPublicNamespace(bucket as never, 'installation-a/', 'initial')).toBe(true);
  const store = createDurablePublicStore(bucket as never, 'installation-a/');
  const fences = createPublicSiteFence(bucket as never, 'installation-a/');
  const held = await fences.acquire('site-a', 'repair', 'owner', 'writer');
  if (!held) throw new Error('Missing fence');
  const hosts = await fences.registerHosts(held, ['example.test']);
  if (!hosts) throw new Error('Missing host');
  const retained = { revision: 'old', generationFence: 1, capture: {'00000000-0000-4000-8000-000000000001': { operation: 'fixture', sequence: 1 }}, tenantSource: 't', policy: 'p', contract: 'v', state: 'active' as const, origins: [], responses: [{ target: '/v1/posts/missing', digest: null, objectKey: null, reason: 'locale_unavailable' as const }] };
  const authority: DurableAuthority = { ...retained, revision: 'current', generationFence: 2, capture: {'00000000-0000-4000-8000-000000000001': { operation: 'fixture', sequence: 1 }}, format: 1, host: 'example.test', site: 'site-a', operation: 'current', markerSource: 'source', fence: 2, markerFence: 2, previousPublication: null, intent: null, previousState: null, candidate: null, rollback: [retained], responses: [{ target: '/v1/posts/missing', digest: null, objectKey: null }] };
  await store.compareAndSetAuthority(authority, null);
  const current = await store.readAuthority('example.test');
  if (!current) throw new Error('Missing authority');
  expect(await fences.revalidateRollback(hosts, current, 'old', { tenantSource: 't', policy: 'p', contract: 'v' }, async () => true)).toBeNull();
});

it('requires a retirement seal and a new owner to clear it', async () => {
  worker = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', r2Buckets: ['PUBLIC'] });
  const bucket = await worker.getR2Bucket('PUBLIC');
  expect(await bootstrapPublicNamespace(bucket as never, 'installation-a/', 'initial')).toBe(true);
  const store = createDurablePublicStore(bucket as never, 'installation-a/');
  const fences = createPublicSiteFence(bucket as never, 'installation-a/');
  const held = await fences.acquire('site-a', 'retire', 'owner', 'writer');
  if (!held) throw new Error('Missing fence');
  const hosts = await fences.registerHosts(held, ['example.test']);
  if (!hosts) throw new Error('Missing host');
  await store.compareAndSetAuthority({ format: 1, host: 'example.test', site: 'site-a', revision: 'retire', generationFence: 2, capture: {'00000000-0000-4000-8000-000000000001': { operation: 'fixture', sequence: 1 }}, tenantSource: 't', policy: 'p', contract: 'v', state: 'denied', operation: 'retire', markerSource: 'source', fence: 2, markerFence: 2, previousPublication: null, intent: null, previousState: null, origins: [], responses: [], candidate: null, rollback: [] }, null);
  const sealed = await fences.sealRetirement(hosts, { operation: 'retire', markerSource: 'source' });
  if (!sealed || !await fences.release(sealed)) throw new Error('Cannot seal retirement');
  expect(await publicHostRetired(store, fences, 'example.test', async () => true)).toBe(true);
  const next = await fences.acquire('site-a', 'prepare', 'next', 'writer');
  if (!next) throw new Error('Missing new owner');
  const cleared = await fences.clearRetirement(next);
  expect(cleared?.value.retirement).toBeNull();
  expect(await publicHostRetired(store, fences, 'example.test', async () => true)).toBe(false);
});

it('does not retire old-site pins while a new owner preparation references them', async () => {
  worker = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', r2Buckets: ['PUBLIC'] });
  const bucket = await worker.getR2Bucket('PUBLIC');
  expect(await bootstrapPublicNamespace(bucket as never, 'installation-a/', 'initial')).toBe(true);
  const store = createDurablePublicStore(bucket as never, 'installation-a/');
  const fences = createPublicSiteFence(bucket as never, 'installation-a/');
  const owner = await fences.acquire('site-a', 'retire', 'owner', 'writer');
  if (!owner) throw new Error('Missing owner');
  const hosts = await fences.registerHosts(owner, ['example.test']);
  if (!hosts) throw new Error('Missing host');
  const prior: DurableAuthority = { format: 1, host: 'example.test', site: 'site-a', revision: 'old', generationFence: 0, capture: {}, tenantSource: 'tenant-a', policy: 'old', contract: 'v1', state: 'denied', operation: 'old', markerSource: 'source-a', fence: 1, markerFence: 1, previousPublication: null, intent: null, previousState: null, origins: [], responses: [], candidate: null, rollback: [] };
  expect(await store.compareAndSetAuthority(prior, null)).toBe(true);
  const previous = await store.readAuthority(prior.host);
  if (!previous) throw new Error('Missing prior authority');
  const digest = 'a'.repeat(64);
  const generation = { revision: 'new', generationFence: 2, capture: { '00000000-0000-4000-8000-000000000001': { operation: 'new', sequence: 1 } }, tenantSource: 'tenant-b', policy: 'new', contract: 'v1', state: 'active' as const, origins: [], responses: [{ target: '/v1/posts', digest, objectKey: `site-a/old/1/${digest}` }] };
  const replacement: DurableAuthority = { ...prior, site: 'site-b', operation: 'new', markerSource: 'source-b', fence: 2, markerFence: 2, intent: 'publish', previousState: 'denied', preparation: { generation, targets: ['/v1/posts'] } };
  expect(await store.compareAndSetAuthority(replacement, previous.etag)).toBe(true);
  const current = await store.readAuthority(prior.host);
  if (!current) throw new Error('Missing replacement authority');
  expect(await fences.retireHost(hosts, prior.host, previous, current)).toBeNull();
});
