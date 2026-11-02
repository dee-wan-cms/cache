import type { D1CacheProfile } from './profile';

type FreshnessPolicy = Pick<NonNullable<D1CacheProfile['readResponseLease']>, 'freshnessCookie' | 'freshnessHeader' | 'ignoreRequestCacheControl'>;
export const validFreshnessHeader = (name: string): boolean => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name);
export const hasFreshnessCookie = (request: Request, name: string): boolean => (request.headers.get('cookie') ?? '').split(';').some((part) => part.split('=', 1)[0]?.trim() === name);
export const hasFreshnessGeneration = (request: Request, name: string): boolean => {
  const matches = (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim()).filter((part) => part.split('=', 1)[0]?.trim() === name);
  const value = matches[0]?.slice(matches[0].indexOf('=') + 1).trim() ?? '';
  return matches.length === 1 && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
};
export const hasCacheBypass = (request: Request): boolean => (request.headers.get('cache-control') ?? '').split(',').some((part) => /^\s*(?:no-cache|no-store)(?:\s*=|\s*$)/i.test(part));

export function regionalD1MetadataTtl(request: Request, policy: FreshnessPolicy): 0 | 5000 {
  if (request.method !== 'GET' || hasFreshnessCookie(request, policy.freshnessCookie)) return 0;
  if (policy.freshnessHeader !== undefined && (!validFreshnessHeader(policy.freshnessHeader) || request.headers.has(policy.freshnessHeader))) return 0;
  if (!policy.ignoreRequestCacheControl && hasCacheBypass(request)) return 0;
  return 5000;
}
