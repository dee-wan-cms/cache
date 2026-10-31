import { expect, it, vi } from 'vitest';
import { createSingleFlight } from '../../src/client';

it('coalesces each pending key and removes settled and failed requests', async () => {
  const flight = createSingleFlight<string, number>();
  let release!: (value: number) => void;
  const held = new Promise<number>((resolve) => { release = resolve; });
  const load = vi.fn(() => held);
  const first = flight.run('a', load);
  expect(flight.run('a', load)).toBe(first);
  expect(await flight.run('b', async () => 7)).toBe(7);
  release(3);
  expect(await first).toBe(3);
  expect(load).toHaveBeenCalledOnce();
  expect(await flight.run('a', async () => 4)).toBe(4);
  await expect(flight.run('a', async () => { throw Error('failed'); })).rejects.toThrow('failed');
  expect(await flight.run('a', async () => 5)).toBe(5);
});

it('does not let an older completion remove a replacement', async () => {
  const flight = createSingleFlight<string, number>();
  let oldDone!: (value: number) => void;
  let newDone!: (value: number) => void;
  const old = flight.run('a', () => new Promise<number>((resolve) => { oldDone = resolve; }));
  await Promise.resolve();
  flight.forget('a');
  const current = flight.run('a', () => new Promise<number>((resolve) => { newDone = resolve; }));
  await Promise.resolve();
  oldDone(1); await old;
  expect(flight.run('a', async () => 99)).toBe(current);
  newDone(2); expect(await current).toBe(2);
});
