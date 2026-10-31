import type { D1CacheProfile } from './d1/profile';
import { needsFreshness } from './d1/read-freshness-policy';

export function createSingleFlight<Key, Value>() {
  const pending = new Map<Key, Promise<Value>>();
  return {
    run(key: Key, load: () => Promise<Value>): Promise<Value> {
      const existing = pending.get(key);
      if (existing) return existing;
      const promise = Promise.resolve().then(load);
      pending.set(key, promise);
      void promise.then(() => { if (pending.get(key) === promise) pending.delete(key); }, () => { if (pending.get(key) === promise) pending.delete(key); });
      return promise;
    },
    forget(key: Key): void { pending.delete(key); },
  };
}

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
      if (needsFreshness(method, pathname, policy.freshnessCookieExcludedPaths) && !usesGenerationCookie(policy, url, transport)) until.set(scope, time + (Number.isInteger(policy.maxSeconds) && policy.maxSeconds !== undefined && policy.maxSeconds >= 1 && policy.maxSeconds <= 300 ? policy.maxSeconds : 5) * 1000);
    },
  };
}

function monotonicNow(): number {
  const clock: unknown = Reflect.get(globalThis, 'performance');
  if (clock && typeof clock === 'object') {
    const read: unknown = Reflect.get(clock, 'now');
    if (typeof read === 'function') {
      const value: unknown = Reflect.apply(read, clock, []);
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
  }
  return Date.now();
}

export function createRevalidationWindow(windowMs: number, now: () => number = monotonicNow) {
  const duration = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 300_000;
  const scopes = new Map<string, number>();
  return {
    remaining(scope: string): number {
      const time = now();
      let deadline = scopes.get(scope);
      if (deadline === undefined) { deadline = time + duration; scopes.set(scope, deadline); }
      return Math.max(0, deadline - time);
    },
    take(scope: string): boolean {
      const time = now();
      const deadline = scopes.get(scope);
      if (deadline !== undefined && time < deadline) return false;
      scopes.set(scope, time + duration);
      return true;
    },
  };
}

export interface MutationInvalidationEvent {
  scope: string;
  method: string;
  pathname: string;
}

export interface MutationInvalidationChannel {
  readonly name: string;
  postMessage(value: MutationInvalidationEvent): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  close(): void;
}

const mutationChannelName = 'dee-wan-cache-invalidation-v1';
const validScope = (scope: string): boolean => /^[A-Za-z0-9:_-]{1,256}$/.test(scope);
const validMethod = (method: string): boolean => /^[!#$%&'*+.^_`|~0-9A-Z-]{1,32}$/.test(method);
const validPathname = (pathname: string): boolean => pathname.startsWith('/') && pathname.length <= 2048 && ![...pathname].some((character) => character === '?' || character === '#' || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

function invalidationChannel(value: unknown): value is MutationInvalidationChannel {
  return !!value && typeof value === 'object' && Reflect.get(value, 'name') === mutationChannelName && ['postMessage', 'addEventListener', 'removeEventListener', 'close'].every((name) => typeof Reflect.get(value, name) === 'function');
}

function browserInvalidationChannel(): MutationInvalidationChannel | undefined {
  const document: unknown = Reflect.get(globalThis, 'document');
  if (!document || typeof document !== 'object') return undefined;
  const constructor: unknown = Reflect.get(globalThis, 'BroadcastChannel');
  if (typeof constructor !== 'function') return undefined;
  try { const channel: unknown = Reflect.construct(constructor, [mutationChannelName]); return invalidationChannel(channel) ? channel : undefined; } catch { return undefined; }
}

export function createMutationInvalidation(policy: Pick<NonNullable<D1CacheProfile['readResponseLease']>, 'freshnessCookieExcludedPaths'>, options: { channel?: MutationInvalidationChannel | null } = {}) {
  const supplied = options.channel === undefined ? browserInvalidationChannel() : options.channel;
  const channel = invalidationChannel(supplied) ? supplied : undefined;
  const listeners = new Map<string, Set<(event: MutationInvalidationEvent) => void>>();
  let disposed = false;
  const notify = (event: MutationInvalidationEvent) => {
    for (const listener of listeners.get(event.scope) ?? []) {
      try { listener({ ...event }); } catch { /* Subscribers are independent. */ }
    }
  };
  const receive = ({ data }: { data: unknown }) => {
    try {
      if (disposed || !data || typeof data !== 'object' || Object.keys(data).sort().join(',') !== 'method,pathname,scope') return;
      const scope: unknown = Reflect.get(data, 'scope');
      const method: unknown = Reflect.get(data, 'method');
      const pathname: unknown = Reflect.get(data, 'pathname');
      if (typeof scope !== 'string' || !validScope(scope) || typeof method !== 'string' || !validMethod(method) || typeof pathname !== 'string' || !validPathname(pathname) || !needsFreshness(method, pathname, policy.freshnessCookieExcludedPaths)) return;
      notify({ scope, method, pathname });
    } catch { /* Ignore malformed messages. */ }
  };
  channel?.addEventListener('message', receive);
  return {
    publish(scope: string, method: string, url: string): void {
      if (disposed || !validScope(scope)) return;
      const normalized = method.toUpperCase();
      if (!validMethod(normalized)) return;
      let pathname: string;
      try { pathname = new URL(url, 'https://cache.invalid').pathname; } catch { return; }
      if (!validPathname(pathname) || !needsFreshness(normalized, pathname, policy.freshnessCookieExcludedPaths)) return;
      const event = { scope, method:normalized, pathname };
      notify(event);
      try { channel?.postMessage({ scope, method:normalized, pathname }); } catch { /* Local notification remains available. */ }
    },
    subscribe(scope: string, listener: (event: MutationInvalidationEvent) => void): () => void {
      if (disposed || !validScope(scope)) return () => {};
      let group = listeners.get(scope);
      if (!group) { group = new Set(); listeners.set(scope, group); }
      group.add(listener);
      const subscribed = group;
      return () => { subscribed.delete(listener); if (subscribed.size === 0 && listeners.get(scope) === subscribed) listeners.delete(scope); };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      channel?.removeEventListener('message', receive);
      channel?.close();
    },
  };
}
