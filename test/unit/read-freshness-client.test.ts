import { expect, it } from 'vitest';
import type { D1CacheProfile } from '../../src/d1/profile';
import { createReadFreshness } from '../../src/client';

const policy: NonNullable<D1CacheProfile['readResponseLease']> = {
  databaseBinding:'DB', deploymentEnv:'RELEASE', paths:['/metadata'], credentialHeaders:['cookie'], varyHeaders:['origin'], freshnessCookie:'fresh', freshnessHeader:'x-read-fresh', freshnessCookieExcludedPaths:['/presence/*', '/draft/*/heartbeat', '/query'],
};

it('keeps a five-second window for successful data mutations in each scope', () => {
  let time = 100_000;
  const tracker = createReadFreshness(policy, () => time);
  tracker.observe('a', 'POST', '/items/1?x=1');
  expect(tracker.headers('a', 'GET')).toEqual({ 'Cache-Control':'no-cache', 'x-read-fresh':'1' });
  expect(tracker.headers('b', 'GET')).toEqual({});
  expect(tracker.headers('a', 'POST')).toEqual({});
  time += 4999;
  expect(tracker.headers('a', 'get')).toHaveProperty('x-read-fresh', '1');
  time++;
  expect(tracker.headers('a', 'GET')).toEqual({});
  tracker.observe('b', 'PATCH', 'https://example.test/items/1');
  expect(tracker.headers('b', 'GET')).toHaveProperty('x-read-fresh', '1');
  expect(tracker.headers('a', 'GET')).toEqual({});
});

it('excludes configured presence, draft and read-only POST paths by whole segment', () => {
  const tracker = createReadFreshness(policy, () => 100_000);
  for (const url of ['/presence/1?refresh=true', '/draft/1/heartbeat', 'https://example.test/query?q=one']) tracker.observe('a', 'POST', url);
  for (const method of ['GET', 'HEAD', 'OPTIONS']) tracker.observe('a', method, '/items/1');
  expect(tracker.headers('a', 'GET')).toEqual({});
  tracker.observe('a', 'POST', '/presence/1/other');
  expect(tracker.headers('a', 'GET')).toHaveProperty('x-read-fresh', '1');
});

it('defaults unknown or malformed mutation URLs to a fresh read', () => {
  const tracker = createReadFreshness(policy, () => 100_000);
  tracker.observe('a', 'DELETE', '/unknown');
  tracker.observe('b', 'PUT', 'http://[');
  expect(tracker.headers('a', 'GET')).toHaveProperty('x-read-fresh', '1');
  expect(tracker.headers('b', 'GET')).toHaveProperty('x-read-fresh', '1');
});


it('does not clear or extend an existing window for excluded operations', () => {
  let time = 100_000;
  const tracker = createReadFreshness({ freshnessHeader:'x-read-fresh', freshnessCookieExcludedPaths:['/presence/*'] }, () => time);
  tracker.observe('a', 'PATCH', '/items/1');
  time = 104_000;
  tracker.observe('a', 'POST', '/presence/1');
  expect(tracker.headers('a', 'GET')).toHaveProperty('x-read-fresh', '1');
  time = 105_000;
  expect(tracker.headers('a', 'GET')).toEqual({});
});
