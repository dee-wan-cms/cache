import type { D1CacheProfile } from './d1/profile';
import { needsFreshness } from './d1/read-freshness-policy';

type ReadLeasePolicy = Pick<NonNullable<D1CacheProfile['readResponseLease']>, 'freshnessHeader' | 'freshnessCookieExcludedPaths' | 'maxSeconds' | 'freshnessCookieMode'> & Partial<Pick<NonNullable<D1CacheProfile['readResponseLease']>, 'credentialHeaders'>>;

export interface FreshnessTransport { origin?: string; baseUrl?: string; withCredentials?: boolean }

function usesGenerationCookie(policy: ReadLeasePolicy, url: string, transport?: FreshnessTransport): boolean {
  if (policy.freshnessCookieMode !== 'generation' || !policy.credentialHeaders?.some((name) => name.toLowerCase() === 'cookie') || transport?.withCredentials !== true || !transport.origin || transport.baseUrl === undefined) return false;
  try {
    const origin = new URL(transport.origin).origin;
    const base = new URL(transport.baseUrl, origin);
    return origin !== 'null' && new URL(url, base).origin === origin;
  } catch { return false; }
}

export function createReadFreshness(policy: ReadLeasePolicy, now: () => number = Date.now) {
  const until = new Map<string, number>();
  const prune = (time: number) => { for (const [scope, deadline] of until) if (deadline <= time) until.delete(scope); };
  return {
    headers(scope: string, method: string): Record<string, string> {
      const time = now();
      prune(time);
      if (method.toUpperCase() !== 'GET' || !until.has(scope)) return {};
      return { 'Cache-Control':'no-cache', ...(policy.freshnessHeader ? { [policy.freshnessHeader]:'1' } : {}) };
    },
    observe(scope: string, method: string, url: string, transport?: FreshnessTransport): void {
      const time = now();
      prune(time);
      let pathname: string;
      try { pathname = new URL(url, 'https://cache.invalid').pathname; } catch { pathname = ''; }
      if (needsFreshness(method, pathname, policy.freshnessCookieExcludedPaths) && !usesGenerationCookie(policy, url, transport)) until.set(scope, time + (Number.isInteger(policy.maxSeconds) && policy.maxSeconds !== undefined && policy.maxSeconds >= 1 && policy.maxSeconds <= 30 ? policy.maxSeconds : 5) * 1000);
    },
  };
}
