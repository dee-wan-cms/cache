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

it('uses the configured maximum window for writer freshness', () => {
  let time = 100_000;
  const tracker = createReadFreshness({ freshnessHeader:'x-read-fresh', maxSeconds:30 }, () => time);
  tracker.observe('a', 'POST', '/items/1');
  time = 129_999;
  expect(tracker.headers('a', 'GET')).toHaveProperty('x-read-fresh', '1');
  time = 130_000;
  expect(tracker.headers('a', 'GET')).toEqual({});
});

it('uses the generation cookie only for confirmed same-origin credentialed writes', () => {
  const generation = { maxSeconds:30, freshnessHeader:'x-read-fresh', freshnessCookieMode:'generation' as const, credentialHeaders:['Cookie'] };
  const tracker = createReadFreshness(generation, () => 100_000);
  tracker.observe('same', 'POST', '/items/1', { origin:'https://cms.example', baseUrl:'/api', withCredentials:true });
  expect(tracker.headers('same', 'GET')).toEqual({});
  tracker.observe('cross', 'POST', '/items/1', { origin:'https://cms.example', baseUrl:'https://api.example', withCredentials:true });
  tracker.observe('no-credentials', 'POST', '/items/1', { origin:'https://cms.example', baseUrl:'/api', withCredentials:false });
  tracker.observe('ssr', 'POST', '/items/1');
  for (const scope of ['cross', 'no-credentials', 'ssr']) expect(tracker.headers(scope, 'GET')).toHaveProperty('x-read-fresh', '1');
  const noCookie = createReadFreshness({ ...generation, credentialHeaders:['authorization'] }, () => 100_000);
  noCookie.observe('a', 'POST', '/items/1', { origin:'https://cms.example', baseUrl:'/api', withCredentials:true });
  expect(noCookie.headers('a', 'GET')).toHaveProperty('x-read-fresh', '1');
});

it('checks the actual mutation URL before relying on a same-origin generation cookie', () => {
  const policy = { freshnessHeader:'x-read-fresh', freshnessCookieMode:'generation' as const, credentialHeaders:['cookie'] };
  const tracker = createReadFreshness(policy, () => 100_000);
  const transport = { origin:'https://cms.example', baseUrl:'/api', withCredentials:true };
  tracker.observe('absolute', 'POST', 'https://other.example/items', transport);
  tracker.observe('protocol-relative', 'POST', '//other.example/items', transport);
  expect(tracker.headers('absolute', 'GET')).toHaveProperty('x-read-fresh', '1');
  expect(tracker.headers('protocol-relative', 'GET')).toHaveProperty('x-read-fresh', '1');
  tracker.observe('same', 'POST', '', transport);
  expect(tracker.headers('same', 'GET')).toEqual({});
  tracker.observe('empty-base', 'POST', '/items', { ...transport, baseUrl:'' });
  expect(tracker.headers('empty-base', 'GET')).toEqual({});
  tracker.observe('empty-base-cross', 'POST', '//other.example/items', { ...transport, baseUrl:'' });
  expect(tracker.headers('empty-base-cross', 'GET')).toHaveProperty('x-read-fresh', '1');
});


it('accepts a JSON-shaped policy with a widened string mode', () => {
  const mode: string = 'generation';
  const jsonPolicy = { ...policy, freshnessCookieMode:mode };
  const typed: NonNullable<D1CacheProfile['readResponseLease']> = jsonPolicy;
  expect(createReadFreshness(typed).headers('a', 'GET')).toEqual({});
});
