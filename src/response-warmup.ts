import { createRegionalCache } from './d1/regional';

export type ReadResponseWarmupTarget = string | { url: string; scope: string | null };

export interface ReadResponseWarmupContext { scope: string | null; popularScopes: readonly string[] }

export interface ReadResponseWarmupOptions {
  scopeHeader: string;
  seeds: readonly ReadResponseWarmupTarget[];
  catalogScope?: 'credential';
  discoveryPriority?: 'next';
  discoverScopeFrom?: string;
  isCurrent?: () => boolean;
  discover?: (url: URL, body: unknown, context: ReadResponseWarmupContext) => { scope?: string; targets: readonly ReadResponseWarmupTarget[] };
  portable?: (url: URL) => boolean;
  maxTargets?: number;
  maxEntries?: number;
  concurrency?: number;
  cooldownMs?: number;
  maxMilliseconds?: number;
  catalogTtlMs?: number;
}

type Entry = { url: string; count: number; time: number; scope?: string | null };
type WarmJob = { url: string; scope: string | null; override: boolean; priority: number };
const catalog = createRegionalCache(86_400_000, 128_000);
const validScope = (value: string | null | undefined): value is string => !!value && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);

export function createResponseWarmup<Env, Context>(run: (request: Request, env: Env, context: Context) => Promise<Response>, canRun: () => boolean = () => true) {
  let generation = 0;
  const internal = new WeakMap<Request, { generation: number; isCurrent?: () => boolean }>();
  const active = new Map<string, number>();
  const verified = new WeakSet<Request>();
  let running = 0, waiting = 0;
  const currentValue = (check?: () => boolean) => { try { return check === undefined || check() === true; } catch { return false; } };
  const acquire = async (limit: number, current: number, end: number, check?: () => boolean): Promise<(() => void) | null> => {
    if (waiting >= 256) return null;
    waiting++;
    try {
      while (current === generation && currentValue(check) && Date.now() < end) {
        if (running < limit && canRun()) { running++; return () => { running--; }; }
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, Math.max(0, end - Date.now()))));
      }
      return null;
    } finally { waiting--; }
  };
  const invalidate = () => { generation++; active.clear(); };
  const allowed = (request: Request) => {
    const meta = internal.get(request);
    return !meta || (meta.generation === generation && currentValue(meta.isCurrent) && !request.signal.aborted);
  };
  const isInternal = (request: Request) => internal.has(request);
  const verify = (request: Request) => { if (allowed(request)) verified.add(request); };
  async function start(options: ReadResponseWarmupOptions | undefined, request: Request, response: Response, identity: unknown[], group: string, eligible: (url: URL) => boolean, env: Env, context: Context, freshnessHeader?: string, credentialGroup?: string) {
    try {
    if (!options || isInternal(request)) return;
    const { scopeHeader, seeds, discover, portable, discoverScopeFrom, isCurrent, catalogScope, discoveryPriority } = options;
    if (isCurrent !== undefined && typeof isCurrent !== 'function') return;
    if (!currentValue(isCurrent)) return;
    const maxTargets = options.maxTargets ?? 48, maxEntries = options.maxEntries ?? 32, concurrency = options.concurrency ?? 4;
    const cooldown = options.cooldownMs ?? 30_000, duration = options.maxMilliseconds ?? 25_000, ttl = options.catalogTtlMs ?? 86_400_000;
    if (typeof scopeHeader !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(scopeHeader) || !Array.isArray(seeds) || seeds.length > 256 || !seeds.every((v) => typeof v === 'string' || (!!v && typeof v === 'object' && typeof v.url === 'string' && (v.scope === null || validScope(v.scope)))) || (catalogScope !== undefined && catalogScope !== 'credential') || (discoveryPriority !== undefined && discoveryPriority !== 'next') || (catalogScope === 'credential' && !credentialGroup) || (discoverScopeFrom !== undefined && (typeof discoverScopeFrom !== 'string' || typeof discover !== 'function')) || (discover !== undefined && typeof discover !== 'function') || (portable !== undefined && typeof portable !== 'function') || ![maxTargets, maxEntries, concurrency, cooldown, duration, ttl].every(Number.isSafeInteger) || maxTargets < 1 || maxTargets > 256 || maxEntries < 1 || maxEntries > 128 || concurrency < 1 || concurrency > 16 || cooldown < 0 || cooldown > 86_400_000 || duration < 1 || duration > 30_000 || ttl < 1 || ttl > 86_400_000) return;
    const current = generation, end = Date.now() + duration;
    const stillCurrent = () => current === generation && currentValue(isCurrent);
    const prior = active.get(group);
    const cooling = prior !== undefined && prior > Date.now();
    if (!cooling) active.set(group, end + cooldown);
    if (active.size > 1024) for (const [key, until] of active) { if (until <= Date.now()) active.delete(key); }
    if (active.size > 1024) active.delete(active.keys().next().value ?? '');
    const base = new URL(request.url);
    let scope = request.headers.get(scopeHeader);
    if (!validScope(scope)) scope = null;
    const rootScope = scope;
    const jobKey = (url: string, value: string | null) => JSON.stringify([url, value]);
    const queue: WarmJob[] = [], seen = new Set<string>([jobKey(base.href, scope)]);
    let completedBootstrap: string | undefined;
    const urlFor = (target: string): URL | null => {
      try {
        const url = new URL(target, base);
        if (url.origin !== base.origin || url.username || url.password || url.hash || url.href.length > 2048 || !eligible(url)) return null;
        return url;
      } catch { return null; }
    };
    const bootstrap = discoverScopeFrom === undefined ? null : urlFor(discoverScopeFrom);
    if (discoverScopeFrom !== undefined && (!bootstrap || !seeds.some((seed) => typeof seed === 'string' && urlFor(seed)?.href === bootstrap.href))) return;
    const enqueue = (target: ReadResponseWarmupTarget, priority = 2) => {
      if (typeof target !== 'string' && (!target || typeof target !== 'object' || typeof target.url !== 'string' || !(target.scope === null || validScope(target.scope)))) return;
      const explicit = typeof target !== 'string';
      const url = urlFor(explicit ? target.url : target);
      const targetScope = explicit ? target.scope : scope;
      const key = url && jobKey(url.href, targetScope);
      if (!url || !key || key === completedBootstrap) return;
      if (seen.has(key)) {
        const existing = queue.findIndex((job) => job.url === url.href && job.scope === targetScope);
        const queued = existing >= 0 ? queue[existing] : undefined;
        if (queued && queued.priority > priority) {
          queue.splice(existing, 1); queued.priority = priority;
          const index = queue.findIndex((item) => item.priority > priority);
          if (index === -1) queue.push(queued); else queue.splice(index, 0, queued);
        }
        return;
      }
      if (seen.size > maxTargets && priority < 2) {
        let index = queue.length - 1;
        while (index >= 0 && queue[index]?.priority !== 2) index--;
        if (index >= 0) { const removed = queue.splice(index, 1)[0]; if (removed) seen.delete(jobKey(removed.url, removed.scope)); }
      }
      if (seen.size > maxTargets) return;
      seen.add(key);
      const job = { url:url.href, scope:targetScope, override:explicit || (!request.headers.has(scopeHeader) && targetScope !== null), priority };
      const index = queue.findIndex((item) => item.priority > priority);
      if (index === -1) queue.push(job); else queue.splice(index, 0, job);
    };
    const keyFor = async (value: string | null) => catalog.regionalKey(ttl, catalogScope === 'credential' ? ['response-warmup-credential-v1', identity, credentialGroup] : ['response-warmup-v1', identity, value]);
    let loadedScope: string | null | undefined;
    const popularScopes: string[] = [];
    const load = async () => {
      if (catalogScope !== 'credential' && !scope) return;
      const lookup = catalogScope === 'credential' ? null : scope;
      if (loadedScope === lookup) return;
      loadedScope = lookup;
      const key = await keyFor(lookup);
      const result = await catalog.regionalRead(key, ttl);
      if (!Array.isArray(result?.value)) return;
      for (const entry of result.value) {
        if (!entry || typeof entry !== 'object' || typeof entry.url !== 'string' || typeof entry.time !== 'number' || Date.now() - entry.time >= ttl) continue;
        if (catalogScope === 'credential') {
          if (entry.scope === null || validScope(entry.scope)) {
            if (validScope(entry.scope) && !popularScopes.includes(entry.scope) && urlFor(entry.url)) popularScopes.push(entry.scope);
            enqueue({ url:entry.url, scope:entry.scope }, 0);
          }
        } else enqueue(entry.url, 0);
      }
    };
    const record = async (url: URL) => {
      const effectiveScope = rootScope ?? scope;
      if ((catalogScope !== 'credential' && !effectiveScope) || !portable?.(url)) return;
      const key = await keyFor(effectiveScope), result = await catalog.regionalRead(key, ttl);
      const entries: Entry[] = Array.isArray(result?.value) ? result.value.filter((v): v is Entry => !!v && typeof v.url === 'string' && typeof v.count === 'number' && Number.isFinite(v.count) && typeof v.time === 'number' && Date.now() - v.time < ttl && !!urlFor(v.url) && (catalogScope !== 'credential' || v.scope === null || validScope(v.scope))).slice(0, maxEntries) : [];
      const existing = entries.find((item) => item.url === url.href && (catalogScope !== 'credential' || item.scope === effectiveScope));
      if (existing) { existing.count = Math.min(existing.count + 1, 1_000_000); existing.time = Date.now(); }
      else entries.push({ url:url.href, count:1, time:Date.now(), ...(catalogScope === 'credential' ? { scope:effectiveScope } : {}) });
      if (catalogScope === 'credential') {
        const totals = new Map<string | null, number>();
        for (const item of entries) totals.set(item.scope ?? null, (totals.get(item.scope ?? null) ?? 0) + item.count);
        entries.sort((a, b) => (totals.get(b.scope ?? null) ?? 0) - (totals.get(a.scope ?? null) ?? 0) || b.count - a.count || b.time - a.time);
      } else entries.sort((a, b) => b.count - a.count || b.time - a.time);
      if (stillCurrent()) await catalog.regionalWrite(key, ttl, Date.now(), entries.slice(0, maxEntries));
    };
    const inspect = async (url: URL, value: Response, deferred?: ReadResponseWarmupTarget[], preload = false) => {
      let body: unknown;
      try {
        if (!discover) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          body = await Promise.race([value.json(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('warmup deadline')), Math.max(0, end - Date.now())); })]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
        if (Date.now() >= end || !stillCurrent()) return;
      } catch { return; }
      finally { void value.body?.cancel().catch(() => undefined); }
      if (preload) await load();
      if (!discover || Date.now() >= end || !stillCurrent()) return;
      let found: { scope?: string; targets: readonly ReadResponseWarmupTarget[] };
      try { found = discover(url, body, { scope:rootScope ?? scope, popularScopes:[...popularScopes] }); }
      catch { return; }
      if (!found || !Array.isArray(found.targets)) return;
      if (!request.headers.has(scopeHeader) && !scope && validScope(found.scope)) {
        scope = found.scope;
        if (bootstrap?.href === url.href) completedBootstrap = jobKey(url.href, scope);
        if (!deferred) await load();
      }
      for (const target of found.targets.slice(0, maxTargets)) {
        if (typeof target !== 'string' && (!target || typeof target !== 'object' || typeof target.url !== 'string' || !(target.scope === null || validScope(target.scope)))) continue;
        if (deferred) deferred.push(target);
        else enqueue(target, discoveryPriority === 'next' ? 1 : 2);
      }
    };
    const runOne = async (target: WarmJob) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (!stillCurrent() || Date.now() >= end) return;
      let release: (() => void) | null = null;
      while (stillCurrent() && Date.now() < end) {
        release = await acquire(concurrency, current, end, isCurrent);
        if (!release) return;
        if (canRun()) break;
        release(); release = null;
      }
      if (!release) return;
      if (!stillCurrent() || Date.now() >= end) { release(); return; }
      const releaseSlot = release;
      let controller: AbortController | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let started = false;
      try {
        const headers = new Headers(request.headers);
        for (const name of ['cache-control', 'pragma', 'range', 'if-match', 'if-unmodified-since', 'if-range', 'if-none-match', 'if-modified-since']) headers.delete(name);
        if (freshnessHeader) headers.delete(freshnessHeader);
        if (target.override) { if (target.scope === null) headers.delete(scopeHeader); else headers.set(scopeHeader, target.scope); }
        controller = new AbortController();
        const abort = controller;
        const watch = () => {
          if (!stillCurrent() || Date.now() >= end) { abort.abort(); return; }
          timer = setTimeout(watch, Math.min(25, Math.max(0, end - Date.now())));
        };
        timer = setTimeout(watch, Math.min(25, Math.max(0, end - Date.now())));
        const warm = new Request(target.url, { method:'GET', headers, redirect:'manual', signal:abort.signal });
        internal.set(warm, { generation:current, isCurrent });
        const task = Promise.resolve().then(() => run(warm, env, context));
        started = true;
        void task.then((response) => { if (abort.signal.aborted) void response.body?.cancel().catch(() => undefined); releaseSlot(); }, () => { releaseSlot(); });
        const result = await Promise.race([task, new Promise<never>((_, reject) => abort.signal.addEventListener('abort', () => reject(Error('warmup deadline')), { once:true }))]);
        if (verified.has(warm) && result.status === 200 && stillCurrent() && Date.now() < end) await inspect(new URL(target.url), result);
        void result.body?.cancel().catch(() => undefined);
      } catch { /* Background warming is best effort. */ }
      finally {
        if (timer !== undefined) clearTimeout(timer);
        if (!started) releaseSlot();
      }
    };
    try {
      if (cooling) { void response.body?.cancel().catch(() => undefined); await record(base); return; }
      const discovered: ReadResponseWarmupTarget[] = [];
      await inspect(base, response, discovered, catalogScope === 'credential' && !bootstrap);
      if (bootstrap && !scope) {
        enqueue(bootstrap.href);
        const index = queue.findIndex((job) => job.url === bootstrap.href && job.scope === scope);
        const job = index === -1 ? undefined : queue.splice(index, 1)[0];
        if (job && stillCurrent() && Date.now() < end) await runOne(job);
        if (!scope || !stillCurrent() || Date.now() >= end) return;
      }
      await load();
      if (discoveryPriority === 'next') for (const target of discovered) enqueue(target, 1);
      for (const seed of seeds) enqueue(seed);
      if (discoveryPriority !== 'next') for (const target of discovered) enqueue(target);
      await record(base);
      const worker = async () => {
        while (queue.length && stillCurrent() && Date.now() < end) {
          const target = queue.shift(); if (!target) return;
          await runOne(target);
        }
      };
      await Promise.all(Array.from({ length:concurrency }, worker));
    } catch { /* Background warming is best effort. */ }
    } finally { void response.body?.cancel().catch(() => undefined); }
  }
  return { start, invalidate, allowed, isInternal, verify, snapshot:() => generation, current:(value: number) => value === generation };
}
