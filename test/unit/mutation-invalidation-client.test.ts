import { expect, it, vi } from 'vitest';
import { createMutationInvalidation, type MutationInvalidationChannel, type MutationInvalidationEvent } from '../../src/client';

function channels() {
  const members = new Set<TestChannel>();
  class TestChannel implements MutationInvalidationChannel {
    readonly name = 'dee-wan-cache-invalidation-v1';
    readonly sent: MutationInvalidationEvent[] = [];
    readonly listeners = new Set<(event: { data: unknown }) => void>();
    closed = false;
    constructor() { members.add(this); }
    postMessage(value: MutationInvalidationEvent): void {
      this.sent.push(value);
      for (const member of members) if (member !== this) member.inject(value);
    }
    addEventListener(_type: 'message', listener: (event: { data: unknown }) => void): void { this.listeners.add(listener); }
    removeEventListener(_type: 'message', listener: (event: { data: unknown }) => void): void { this.listeners.delete(listener); }
    close(): void { this.closed = true; members.delete(this); }
    inject(data: unknown): void { for (const listener of this.listeners) listener({ data }); }
  }
  return () => new TestChannel();
}

it('notifies local and other tabs once, isolated by scope, without replaying messages', () => {
  const make = channels();
  const channelA = make(); const channelB = make();
  const a = createMutationInvalidation({}, { channel:channelA });
  const b = createMutationInvalidation({}, { channel:channelB });
  const local = vi.fn(); const remote = vi.fn(); const other = vi.fn();
  a.subscribe('site_a', local); b.subscribe('site_a', remote); b.subscribe('site_b', other);
  a.publish('site_a', 'post', 'https://user:password@example.test/api/items/1?token=secret#section');
  const event = { scope:'site_a', method:'POST', pathname:'/api/items/1' };
  expect(local).toHaveBeenCalledTimes(1);
  expect(local).toHaveBeenCalledWith(event);
  expect(remote).toHaveBeenCalledTimes(1);
  expect(remote).toHaveBeenCalledWith(event);
  expect(other).not.toHaveBeenCalled();
  expect(channelA.sent).toEqual([event]);
  expect(channelB.sent).toEqual([]);
  a.dispose(); b.dispose();
});

it('ignores reads, excluded paths, malformed scopes and untrusted messages', () => {
  const make = channels(); const channel = make();
  const invalidation = createMutationInvalidation({ freshnessCookieExcludedPaths:['/presence/*', '/query'] }, { channel });
  const listener = vi.fn(); invalidation.subscribe('site_a', listener);
  for (const method of ['GET', 'HEAD', 'OPTIONS']) invalidation.publish('site_a', method, '/items/1');
  invalidation.publish('site_a', 'POST', '/presence/a?x=1');
  invalidation.publish('site_a', 'POST', '/query');
  invalidation.publish('site a', 'POST', '/items/1');
  for (const message of [null, {}, { scope:'site_a', method:'GET', pathname:'/items' }, { scope:'site_a', method:'POST', pathname:'/query' }, { scope:'site_a', method:'POST', pathname:'/items?token=x' }, { scope:'site_a', method:'POST', pathname:'/items', token:'secret' }, { scope:'site_a', method:'POST\nX', pathname:'/items' }, { scope:'site_a', method:'POST', pathname:'/' + 'x'.repeat(2048) }]) channel.inject(message);
  expect(listener).not.toHaveBeenCalled();
  expect(channel.sent).toEqual([]);
  invalidation.publish('site_a', 'POST', '/presence/a/other');
  expect(listener).toHaveBeenCalledTimes(1);
  expect(listener).toHaveBeenCalledWith({ scope:'site_a', method:'POST', pathname:'/presence/a/other' });
  invalidation.dispose();
});

it('unsubscribes and disposes listeners and channels without later delivery', () => {
  const make = channels(); const channel = make();
  const invalidation = createMutationInvalidation({}, { channel });
  const listener = vi.fn();
  const unsubscribe = invalidation.subscribe('site_a', listener);
  unsubscribe(); unsubscribe();
  invalidation.publish('site_a', 'PATCH', '/items/1');
  expect(listener).not.toHaveBeenCalled();
  invalidation.subscribe('site_a', listener);
  invalidation.dispose(); invalidation.dispose();
  channel.inject({ scope:'site_a', method:'PATCH', pathname:'/items/1' });
  invalidation.publish('site_a', 'PATCH', '/items/1');
  expect(listener).not.toHaveBeenCalled();
  expect(channel.listeners.size).toBe(0);
  expect(channel.closed).toBe(true);
});

it('does not open a browser channel in Node or accept another channel name', () => {
  const constructor = vi.fn();
  vi.stubGlobal('BroadcastChannel', constructor);
  try {
    const node = createMutationInvalidation({});
    expect(constructor).not.toHaveBeenCalled();
    node.dispose();
  } finally { vi.unstubAllGlobals(); }
  const make = channels(); const channel = make();
  Object.defineProperty(channel, 'name', { value:'other-channel' });
  const invalidation = createMutationInvalidation({}, { channel });
  const listener = vi.fn(); invalidation.subscribe('site_a', listener);
  channel.inject({ scope:'site_a', method:'POST', pathname:'/items' });
  expect(listener).not.toHaveBeenCalled();
  invalidation.dispose();
  expect(channel.closed).toBe(false);
  channel.close();
});
