import { describe, expect, it, vi } from 'vitest';
import { createIntentWarmup } from '../../src/client';

describe('intent warmup', () => {
  it.each(['scope', 'invalidation'] as const)('does not start a queued read after %s changes', async (change) => {
    const warm = createIntentWarmup();
    const read = vi.fn(async () => true);
    warm.setScope('old');
    warm.warm('pages', read);
    if (change === 'scope') warm.setScope('new');
    else warm.invalidate();
    await Promise.resolve();
    expect(read).not.toHaveBeenCalled();
  });

  it('runs one read, retains only the latest queued intent, and cools down successes', async () => {
    let time = 1;
    let release!: (value: boolean) => void;
    const first = vi.fn(() => new Promise<boolean>((resolve) => { release = resolve; }));
    const skipped = vi.fn(async () => true);
    const latest = vi.fn(async () => true);
    const warm = createIntentWarmup(60_000, () => time);
    warm.setScope('site:actor');
    warm.warm('dashboard', first);
    await Promise.resolve();
    warm.warm('pages', skipped);
    warm.warm('planner', latest);
    release(true);
    await vi.waitFor(() => expect(latest).toHaveBeenCalledOnce());
    expect(skipped).not.toHaveBeenCalled();
    warm.warm('dashboard', first);
    expect(first).toHaveBeenCalledOnce();
    time += 60_000;
    warm.warm('dashboard', first);
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(2));
    release(true);
  });

  it('does not cool failures or let old-scope completion warm the new scope', async () => {
    let release!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => { release = resolve; });
    const warm = createIntentWarmup();
    const next = vi.fn(async () => false);
    warm.setScope('old');
    warm.warm('pages', () => pending);
    await Promise.resolve();
    warm.warm('discarded', next);
    warm.setScope('new');
    warm.warm('pages', next);
    release(true);
    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
    warm.warm('pages', next);
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(2));
    warm.invalidate();
  });

  it('clears successful cooldowns on invalidation', async () => {
    const warm = createIntentWarmup();
    const read = vi.fn(async () => true);
    warm.setScope('site:actor');
    warm.warm('pages', read);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    warm.invalidate();
    warm.warm('pages', read);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });

  it('reports invalidation while a sequential warm job is awaiting its first read', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const first = vi.fn(async () => { await held; });
    const second = vi.fn(async () => true);
    const warm = createIntentWarmup();
    warm.setScope('site:actor');
    warm.warm('dashboard', async (isCurrent) => {
      await first();
      return isCurrent() ? second() : false;
    });
    await vi.waitFor(() => expect(first).toHaveBeenCalledOnce());
    warm.invalidate();
    release();
    await held;
    await Promise.resolve();
    expect(second).not.toHaveBeenCalled();
  });
});
