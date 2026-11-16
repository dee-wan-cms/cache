export type LocalFill = { valid: boolean; started: number; done: Promise<void>; finish: () => void; putting: boolean };

export function createLocalFills() {
  const fallback = new Map<string, LocalFill>();
  const caches = new WeakMap<object, Map<string, LocalFill>>();
  let count = 0;
  return {
    has(cache: object | undefined, key: string): boolean {
      return (cache ? caches.get(cache) : fallback)?.has(key) ?? false;
    },
    async acquire(cache: object | undefined, key: string): Promise<{ fill?: LocalFill; retry: boolean }> {
      let fills = cache ? caches.get(cache) : fallback;
      if (!fills) { fills = new Map(); if (cache) caches.set(cache, fills); }
      const active = fills.get(key);
      let retry = false;
      if (active) {
        const remaining = Math.max(0, 1000 - (Date.now() - active.started));
        if (remaining) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([active.done, new Promise<void>((resolve) => { timer = setTimeout(resolve, remaining); })]);
          if (timer !== undefined) clearTimeout(timer);
        }
        if (fills.get(key) === active) {
          active.valid = false;
          if (active.putting) return { retry:false };
          fills.delete(key); count--;
        } else retry = true;
      }
      if (retry) return { retry:true };
      if (fills.has(key) || count >= 1024) return { retry:false };
      let finish = () => {};
      const done = new Promise<void>((resolve) => { finish = resolve; });
      const fill: LocalFill = { valid:true, started:Date.now(), done, finish, putting:false };
      fills.set(key, fill); count++;
      return { fill, retry:false };
    },
    release(cache: object | undefined, key: string, fill: LocalFill): void {
      const fills = cache ? caches.get(cache) : fallback;
      if (fills?.get(key) === fill) { fills.delete(key); count--; }
      fill.finish();
    },
  };
}
