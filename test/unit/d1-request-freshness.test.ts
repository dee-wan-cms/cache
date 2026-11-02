import { expect, it } from 'vitest';
import { regionalD1MetadataTtl } from '../../src/d1/request-freshness';

it('uses strict reads only for explicit freshness or non-GET requests under opt-in policy', () => {
  const policy = { freshnessCookie:'fresh', freshnessHeader:'x-read-fresh', ignoreRequestCacheControl:true };
  const req = (headers: Record<string,string> = {}, method = 'GET') => new Request('https://test.example/data', { headers, method });
  expect(regionalD1MetadataTtl(req(), policy)).toBe(5000);
  expect(regionalD1MetadataTtl(req({ 'cache-control':'no-cache' }), policy)).toBe(5000);
  expect(regionalD1MetadataTtl(req({ 'cache-control':'no-store' }), policy)).toBe(5000);
  expect(regionalD1MetadataTtl(req({ 'x-read-fresh':'1' }), policy)).toBe(0);
  expect(regionalD1MetadataTtl(req({ cookie:'session=a; fresh=1' }), policy)).toBe(0);
  expect(regionalD1MetadataTtl(req({}, 'POST'), policy)).toBe(0);
  expect(regionalD1MetadataTtl(req({ 'cache-control':'no-cache' }), { ...policy, ignoreRequestCacheControl:false })).toBe(0);
  expect(regionalD1MetadataTtl(req({ 'cache-control':'no-store' }), { ...policy, ignoreRequestCacheControl:false })).toBe(0);
  expect(regionalD1MetadataTtl(req(), { ...policy, freshnessHeader:'invalid header' })).toBe(0);
});
