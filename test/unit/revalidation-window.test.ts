import { expect, it } from 'vitest';
import { createRevalidationWindow } from '../../src/client';

it('coalesces per scope without moving an established deadline on observation', () => {
 let time = 1000;
 const window = createRevalidationWindow(300_000, () => time);
 expect(window.remaining('a')).toBe(300_000);
 expect(window.take('a')).toBe(false);
 expect(window.take('b')).toBe(true);
 expect(window.take('b')).toBe(false);
 time += 299_000;
 expect(window.remaining('a')).toBe(1000);
 expect(window.take('a')).toBe(false);
 time += 1000;
 expect(window.take('a')).toBe(true);
 expect(window.take('a')).toBe(false);
 expect(window.remaining('a')).toBe(300_000);
 expect(window.take('b')).toBe(true);
 time += 299_999;
 expect(window.take('a')).toBe(false);
 expect(window.remaining('a')).toBe(1);
 time++;
 expect(window.take('a')).toBe(true);
});
