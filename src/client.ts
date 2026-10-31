import type { D1CacheProfile } from './d1/profile';
import { needsFreshness } from './d1/read-freshness-policy';

type ReadLeasePolicy = Pick<NonNullable<D1CacheProfile['readResponseLease']>, 'freshnessHeader' | 'freshnessCookieExcludedPaths'>;

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
    observe(scope: string, method: string, url: string): void {
      const time = now();
      prune(time);
      let pathname: string;
      try { pathname = new URL(url, 'https://cache.invalid').pathname; } catch { pathname = ''; }
      if (needsFreshness(method, pathname, policy.freshnessCookieExcludedPaths)) until.set(scope, time + 5000);
    },
  };
}
