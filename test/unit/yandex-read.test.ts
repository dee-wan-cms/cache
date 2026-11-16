import { describe, expect, it, vi } from 'vitest';
import { yandexCacheRead } from '../../src/yandex/read';
import type { CacheStore } from '../../src/core/types';

function storeFor(ttls: number[]): CacheStore {
  return {
    beginWrite:async () => {}, endWrite:async () => {}, invalidate:async () => {}, release:async () => {},
    read:async () => ({ kind:'miss', epochs:{ g:0 }, lockToken:'owner', lockHeldForMs:null, pending:false }),
    write:async (request) => { ttls.push(request.ttlMs); return { ok:true }; },
  };
}

describe('Yandex generic read TTL', () => {
  it('jitter stays below the configured ceiling and can be disabled', async () => {
    const ttls: number[] = [];
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      await yandexCacheRead(storeFor(ttls), { key:'a', scope:'s', ttlMs:1000 }, async () => 'value');
      await yandexCacheRead(storeFor(ttls), { key:'b', scope:'s', ttlMs:1000, ttlJitterRatio:0 }, async () => 'value');
      expect(ttls).toEqual([950, 1000]);
    } finally { random.mockRestore(); }
  });
  it('bypasses caching for sub-millisecond ceilings', async () => {
    const ttls: number[] = [];
    await expect(yandexCacheRead(storeFor(ttls), { key:'a', scope:'s', ttlMs:0.5 }, async () => 'value')).resolves.toBe('value');
    expect(ttls).toEqual([]);
  });
});

it('serializes pending-write source reads without sharing their results', async () => {
  const ttls: number[] = [];
  const store = storeFor(ttls);
  store.read = async () => ({ kind:'miss', epochs:{ g:1 }, lockToken:null, lockHeldForMs:null, pending:true });
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let calls = 0, active = 0, max = 0;
  const load = async () => {
    active++; calls++; max = Math.max(max, active);
    try { if (calls === 1) { entered(); await held; } return calls; }
    finally { active--; }
  };
  const first = yandexCacheRead(store, { key:'pending', scope:'s' }, load);
  await started;
  const second = yandexCacheRead(store, { key:'pending', scope:'s' }, load);
  release();
  expect(await Promise.all([first, second])).toEqual([1, 2]);
  expect(max).toBe(1);
  expect(ttls).toEqual([]);
});

it.each([
  ['error', 'pending', 'pending', 'error'],
  ['pending', 'error', 'error', 'pending'],
])('does not deadlock when coordinator state changes (%s then %s)', async (...states) => {
  const store = storeFor([]);
  let reads = 0;
  let release!: () => void;
  const bothStarted = new Promise<void>((resolve) => { release = resolve; });
  store.read = async () => {
    const index = reads++;
    if (reads === 2) release();
    if (index < 2) await bothStarted;
    if (states[index] === 'error') throw new Error('coordinator unavailable');
    return { kind:'miss', epochs:{ g:1 }, lockToken:null, lockHeldForMs:null, pending:true };
  };
  let calls = 0;
  const load = async () => ++calls;
  expect((await Promise.all([yandexCacheRead(store, { key:'flap', scope:'s' }, load), yandexCacheRead(store, { key:'flap', scope:'s' }, load)])).sort()).toEqual([1, 2]);
});
