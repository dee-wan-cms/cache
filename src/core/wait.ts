import type { CacheStore, ReadRequest, ReadResponse } from './types';

export class CacheFillTimeoutError extends Error {
  readonly status = 503;
  readonly statusCode = 503;
  constructor() { super('cache fill wait timed out'); this.name = 'CacheFillTimeoutError'; }
}

export async function waitForFill(store: CacheStore, request: ReadRequest, deadline: number): Promise<ReadResponse> {
  const delays = [50, 100, 200, 500];
  const identity = store.coordinationIdentity ?? store;
  const localKey = JSON.stringify([request.generation ?? "", request.key]);
  for (let attempt = 0; ; attempt++) {
    const result = await store.read(request);
    if (result.kind === 'hit' || result.pending || result.lockToken) return result;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new CacheFillTimeoutError();
    if (await waitLocalOwner(identity, localKey, deadline)) continue;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(delays[Math.min(attempt, delays.length - 1)] ?? 500, remaining)));
  }
}

type LocalOwner = { expires: number; done: Promise<void>; finish: () => void };
const owners = new WeakMap<object, Map<string, LocalOwner>>();
let ownerCount = 0;
const liveOwners = new Set<{ map: Map<string, LocalOwner>; key: string; owner: LocalOwner }>();
const MAX_LOCAL_OWNERS = 1024;
const MAX_LOCAL_WAITERS = 1024;
const localWaiters = new Set<{ expires:number }>();

function ownerMap(identity: object): Map<string, LocalOwner> {
  let map = owners.get(identity);
  if (!map) { map = new Map(); owners.set(identity, map); }
  return map;
}
function removeOwner(map: Map<string, LocalOwner>, key: string, owner: LocalOwner): void {
  if (map.get(key) === owner) { map.delete(key); ownerCount--; }
  for (const entry of liveOwners) if (entry.owner === owner) { liveOwners.delete(entry); break; }
  owner.finish();
}
function currentOwner(map: Map<string, LocalOwner>, key: string): LocalOwner | undefined {
  const owner = map.get(key);
  if (owner && owner.expires <= Date.now()) { removeOwner(map, key, owner); return undefined; }
  return owner;
}
async function awaitOwner(owner: LocalOwner, deadline: number): Promise<void> {
  const expires = Math.min(deadline, owner.expires);
  const remaining = expires - Date.now();
  if (remaining <= 0) return;
  for (const waiter of localWaiters) if (waiter.expires <= Date.now()) localWaiters.delete(waiter);
  if (localWaiters.size >= MAX_LOCAL_WAITERS) throw new CacheFillTimeoutError();
  const waiter = { expires };
  localWaiters.add(waiter);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([owner.done, new Promise<void>((resolve) => { timer = setTimeout(resolve, remaining); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); localWaiters.delete(waiter); }
}
export async function waitLocalOwner(identity: object, key: string, deadline: number): Promise<boolean> {
  const owner = currentOwner(ownerMap(identity), key);
  if (!owner) return false;
  await awaitOwner(owner, deadline);
  if (Date.now() >= deadline) throw new CacheFillTimeoutError();
  return true;
}
function registerOwner(identity: object, key: string, lifetime: number, replace: boolean): { map: Map<string, LocalOwner>; owner: LocalOwner } | undefined {
  const map = ownerMap(identity);
  const previous = currentOwner(map, key);
  if (previous && !replace) return undefined;
  if (previous) removeOwner(map, key, previous);
  if (ownerCount >= MAX_LOCAL_OWNERS) {
    for (const entry of liveOwners) if (entry.owner.expires <= Date.now()) removeOwner(entry.map, entry.key, entry.owner);
    if (ownerCount >= MAX_LOCAL_OWNERS) return undefined;
  }
  let finish = () => {};
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const owner = { expires:Date.now() + lifetime, done, finish };
  map.set(key, owner); ownerCount++;
  liveOwners.add({ map, key, owner });
  return { map, owner };
}
export async function trackLocalFill<T>(identity: object, key: string, lifetime: number, operation: () => Promise<T>): Promise<T> {
  const entry = registerOwner(identity, key, lifetime, true);
  try { return await operation(); }
  finally { if (entry) removeOwner(entry.map, key, entry.owner); }
}
export async function localFillOwner<T>(identity: object, key: string, waitMs: number, operation: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const entry = registerOwner(identity, key, waitMs, false);
    if (entry) {
      try { return await operation(); }
      finally { removeOwner(entry.map, key, entry.owner); }
    }
    const owner = currentOwner(ownerMap(identity), key);
    if (!owner || Date.now() >= deadline) throw new CacheFillTimeoutError();
    await awaitOwner(owner, deadline);
    if (Date.now() >= deadline) throw new CacheFillTimeoutError();
  }
}
