import { describe, expect, it } from 'vitest';
import { localFillOwner, trackLocalFill, waitLocalOwner, CacheFillTimeoutError } from '../../src/core/wait';

function deferred<T>() {
  let resolve!: (value:T) => void;
  let reject!: (reason:Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('local fill notification', () => {
  it('waits for the same identity and key without sharing the owner value', async () => {
    const identity = {};
    const gate = deferred<void>();
    const calls: string[] = [];
    const owner = localFillOwner(identity, 'key', 1000, async () => { calls.push('owner'); await gate.promise; return 'first'; });
    const follower = localFillOwner(identity, 'key', 1000, async () => { calls.push('follower'); return 'second'; });
    const other = await localFillOwner(identity, 'other', 1000, async () => 'other');
    expect(other).toBe('other');
    expect(calls).toEqual(['owner']);
    gate.resolve();
    expect(await owner).toBe('first');
    expect(await follower).toBe('second');
    expect(calls).toEqual(['owner', 'follower']);
  });
  it('cleans up after owner failure and isolates identities', async () => {
    const first = {};
    const second = {};
    const gate = deferred<void>();
    const owner = localFillOwner(first, 'key', 1000, async () => { await gate.promise; throw new Error('source'); });
    const follower = localFillOwner(first, 'key', 1000, async () => 'recovered');
    expect(await localFillOwner(second, 'key', 1000, async () => 'separate')).toBe('separate');
    gate.resolve();
    await expect(owner).rejects.toThrow('source');
    await expect(follower).resolves.toBe('recovered');
  });
  it('times out a follower without admitting duplicate source work', async () => {
    const identity = {};
    const gate = deferred<void>();
    const owner = localFillOwner(identity, 'key', 1000, async () => { await gate.promise; return 1; });
    let invoked = false;
    await expect(localFillOwner(identity, 'key', 5, async () => { invoked = true; return 2; })).rejects.toBeInstanceOf(CacheFillTimeoutError);
    expect(invoked).toBe(false);
    gate.resolve();
    await owner;
  });
  it('bounds waiters and releases their slots after the owner settles', async () => {
    const identity = {};
    const gate = deferred<void>();
    const owner = trackLocalFill(identity, 'capacity', 1000, async () => gate.promise);
    const waiters = Array.from({ length:1024 }, () => waitLocalOwner(identity, 'capacity', Date.now() + 1000));
    await expect(waitLocalOwner(identity, 'capacity', Date.now() + 1000)).rejects.toBeInstanceOf(CacheFillTimeoutError);
    gate.resolve();
    await owner;
    await Promise.all(waiters);
    expect(await waitLocalOwner(identity, 'capacity', Date.now() + 1000)).toBe(false);
  });

});
