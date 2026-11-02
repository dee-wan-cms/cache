import { expect, it } from 'vitest';
import { matchesPath } from '../../src/d1/read-freshness-policy';

it('matches a terminal recursive wildcard without changing single-segment wildcards', () => {
  expect(matchesPath('/api/items/one', ['/api/**'])).toBe(true);
  expect(matchesPath('/api/items', ['/api/*'])).toBe(true);
  expect(matchesPath('/api/items/one', ['/api/*'])).toBe(false);
  expect(matchesPath('/api/items/one', ['/api/**/one'])).toBe(false);
  expect(matchesPath('/other/items', ['/api/**'])).toBe(false);
});
