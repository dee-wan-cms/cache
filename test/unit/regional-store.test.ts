import { expect, it, vi } from "vitest";
import { createRegionalStore } from "../../src/cloudflare/regional-store";
import type {
  CacheStore,
  ReadRequest,
  ReadResponse,
  WriteRequest,
} from "../../src/core/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  let time = 100_000;
  const entries = new Map<string, Response>();
  const cache = {
    match: vi.fn(async (key: RequestInfo | URL) =>
      entries.get(String(key))?.clone(),
    ),
    put: vi.fn(async (key: RequestInfo | URL, response: Response) => {
      entries.set(String(key), response.clone());
    }),
  };
  const read = vi.fn<CacheStore["read"]>(async () => ({
    kind: "miss",
    epochs: { g: 1 },
    pending: false,
    lockToken: "lock",
    lockHeldForMs: null,
  }));
  const write = vi.fn<CacheStore["write"]>(async () => ({ ok: true }));
  const beginWrite = vi.fn<CacheStore["beginWrite"]>(async () => {});
  const endWrite = vi.fn<CacheStore["endWrite"]>(async () => {});
  const invalidate = vi.fn<CacheStore["invalidate"]>(async () => {});
  const release = vi.fn<CacheStore["release"]>(async () => {});
  const store: CacheStore = {
    read,
    write,
    beginWrite,
    endWrite,
    invalidate,
    release,
  };
  const namespace = crypto.randomUUID();
  const options = {
    namespace,
    generation: "g1",
    ttlMs: 5000,
    cache: () => cache,
    now: () => time,
  };
  const request: ReadRequest = {
    key: "k",
    fences: ["g"],
    generation: "g1",
    refresh: true,
    lockMs: 30_000,
  };
  const fill: WriteRequest = {
    key: "k",
    lockToken: "lock",
    snapshot: { g: 1 },
    ttlMs: 20_000,
    softTtlMs: 4000,
    value: '{"data":[1,true]}',
  };
  return {
    store,
    read,
    write,
    beginWrite,
    endWrite,
    invalidate,
    release,
    options,
    request,
    fill,
    cache,
    entries,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

it("promotes accepted fills and bounds them by the source soft TTL", async () => {
  const f = fixture();
  const wrapped = createRegionalStore(f.store, f.options);
  expect((await wrapped.read(f.request)).kind).toBe("miss");
  expect(await wrapped.write(f.fill)).toEqual({ ok: true });
  expect(await wrapped.read(f.request)).toMatchObject({
    kind: "hit",
    value: f.fill.value,
    epochs: { g: 1 },
    refreshToken: null,
  });
  expect(f.read).toHaveBeenCalledTimes(1);
  f.advance(4000);
  expect((await wrapped.read(f.request)).kind).toBe("miss");
  expect(f.read).toHaveBeenCalledTimes(2);
});

it.each([
  "null",
  "false",
  "0",
  '"text"',
  '[1,{"$t":"n","v":"42"}]',
  '{"at":{"$t":"d","v":"2026-01-01T00:00:00.000Z"}}',
])("preserves encoded store value %s", async (value) => {
  const f = fixture();
  const wrapped = createRegionalStore(f.store, f.options);
  await wrapped.read(f.request);
  await wrapped.write({ ...f.fill, value });
  expect(await wrapped.read(f.request)).toMatchObject({
    kind: "hit",
    value,
    refreshToken: null,
  });
});

it("promotes only verified fresh coordinator hits without refresh tokens", async () => {
  const f = fixture();
  const source: ReadResponse = {
    kind: "hit",
    epochs: { g: 1 },
    value: "null",
    refreshToken: null,
    freshUntil: 101_000,
  };
  f.read.mockResolvedValue(source);
  const wrapped = createRegionalStore(f.store, f.options);
  expect(await wrapped.read(f.request)).toEqual(source);
  expect((await wrapped.read(f.request)).kind).toBe("hit");
  expect(f.read).toHaveBeenCalledTimes(1);
  f.advance(1000);
  await wrapped.read(f.request);
  expect(f.read).toHaveBeenCalledTimes(2);
  f.read.mockResolvedValue({
    ...source,
    freshUntil: undefined,
    refreshToken: "refresh",
  });
  await wrapped.read({ ...f.request, key: "other" });
  await wrapped.read({ ...f.request, key: "other" });
  expect(f.read).toHaveBeenCalledTimes(4);
});

it("isolates namespace, generation, keys and fences and permits explicit opt-out", async () => {
  const f = fixture();
  const a = createRegionalStore(f.store, f.options);
  await a.read(f.request);
  await a.write(f.fill);
  const same = createRegionalStore(f.store, f.options);
  expect((await same.read(f.request)).kind).toBe("hit");
  const otherNamespace = createRegionalStore(f.store, {
    ...f.options,
    namespace: "other",
  });
  const otherGeneration = createRegionalStore(f.store, {
    ...f.options,
    generation: "g2",
  });
  expect((await otherNamespace.read(f.request)).kind).toBe("miss");
  expect(
    (await otherGeneration.read({ ...f.request, generation: "g2" })).kind,
  ).toBe("miss");
  expect((await same.read({ ...f.request, fences: ["other"] })).kind).toBe(
    "miss",
  );
  const disabled = createRegionalStore(f.store, {
    ...f.options,
    enabled: false,
  });
  expect((await disabled.read(f.request)).kind).toBe("miss");
  await disabled.invalidate(["g"]);
  expect((await same.read(f.request)).kind).toBe("miss");
  expect(createRegionalStore(f.store, { ...f.options, ttlMs: 5001 })).toBe(
    f.store,
  );
});

it("does not promote rejected fills or return cached lock and refresh tokens", async () => {
  const f = fixture();
  const wrapped = createRegionalStore(f.store, f.options);
  await wrapped.read(f.request);
  f.write.mockResolvedValueOnce({ ok: false, reason: "fence" });
  await wrapped.write(f.fill);
  expect((await wrapped.read(f.request)).kind).toBe("miss");
  expect(f.cache.put).not.toHaveBeenCalled();
  await wrapped.write(f.fill);
  const hit = await wrapped.read(f.request);
  expect(hit.kind === "hit" && hit.refreshToken).toBeNull();
});

it("falls back to the coordinator on cache failures and preserves source errors", async () => {
  const f = fixture();
  const wrapped = createRegionalStore(f.store, f.options);
  f.cache.match.mockRejectedValueOnce(new Error("cache unavailable"));
  expect((await wrapped.read(f.request)).kind).toBe("miss");
  f.cache.put.mockRejectedValueOnce(new Error("cache unavailable"));
  expect(await wrapped.write(f.fill)).toEqual({ ok: true });
  f.read.mockRejectedValueOnce(new Error("coordinator unavailable"));
  await expect(wrapped.read(f.request)).rejects.toThrow(
    "coordinator unavailable",
  );
});

it("blocks regional reads during a local write and invalidates across wrappers", async () => {
  const f = fixture();
  const a = createRegionalStore(f.store, f.options);
  const b = createRegionalStore(f.store, f.options);
  await a.read(f.request);
  await a.write(f.fill);
  const ending = deferred<void>();
  f.endWrite.mockImplementationOnce(() => ending.promise);
  await a.beginWrite({
    fences: ["g"],
    generation: "g1",
    leaseMs: 5000,
    token: "mutation",
  });
  expect((await b.read(f.request)).kind).toBe("miss");
  const pending = a.endWrite({ fences: ["g"], token: "mutation" });
  expect((await b.read(f.request)).kind).toBe("miss");
  ending.resolve();
  await pending;
  expect((await b.read(f.request)).kind).toBe("miss");
});

it("does not resurrect a regional fill that completes after invalidation", async () => {
  const f = fixture();
  const wrapped = createRegionalStore(f.store, f.options);
  await wrapped.read(f.request);
  const pending = deferred<void>();
  const entered = deferred<void>();
  f.cache.put.mockImplementationOnce(async (key, response) => {
    entered.resolve();
    await pending.promise;
    f.entries.set(String(key), response.clone());
  });
  const writing = wrapped.write(f.fill);
  await entered.promise;
  await wrapped.invalidate(["g"]);
  pending.resolve();
  await writing;
  expect((await wrapped.read(f.request)).kind).toBe("miss");
});

it("does not promote a coordinator hit if a local write begins during its read", async () => {
  const f = fixture();
  const wrapped = createRegionalStore(f.store, f.options);
  const pending = deferred<ReadResponse>();
  f.read.mockImplementationOnce(() => pending.promise);
  const reading = wrapped.read(f.request);
  await Promise.resolve();
  await wrapped.beginWrite({
    fences: ["g"],
    generation: "g1",
    leaseMs: 5000,
    token: "mutation",
  });
  pending.resolve({
    kind: "hit",
    epochs: { g: 1 },
    refreshToken: null,
    freshUntil: 104_000,
    value: '"old"',
  });
  await reading;
  expect(f.cache.put).not.toHaveBeenCalled();
  await wrapped.endWrite({ fences: ["g"], token: "mutation" });
  expect((await wrapped.read(f.request)).kind).toBe("miss");
});

it("keeps the regional path disabled when invalidation or ending a write fails", async () => {
  const f = fixture();
  const wrapped = createRegionalStore(f.store, f.options);
  f.invalidate.mockRejectedValueOnce(new Error("invalidate failed"));
  await expect(wrapped.invalidate(["g"])).rejects.toThrow("invalidate failed");
  await wrapped.read(f.request);
  await wrapped.write(f.fill);
  expect(f.cache.put).not.toHaveBeenCalled();
  const next = fixture();
  const another = createRegionalStore(next.store, next.options);
  await another.beginWrite({
    fences: ["g"],
    generation: "g1",
    leaseMs: 5000,
    token: "mutation",
  });
  next.endWrite.mockRejectedValueOnce(new Error("end failed"));
  await expect(
    another.endWrite({ fences: ["g"], token: "mutation" }),
  ).rejects.toThrow("end failed");
  await another.read(next.request);
  await another.write(next.fill);
  expect(next.cache.put).not.toHaveBeenCalled();
});

it("does not promote an accepted fill whose write overlaps a local mutation", async () => {
  const f = fixture();
  const wrapped = createRegionalStore(f.store, f.options);
  await wrapped.read(f.request);
  const pending = deferred<{ ok: true }>();
  f.write.mockImplementationOnce(() => pending.promise);
  const writing = wrapped.write(f.fill);
  await wrapped.beginWrite({
    fences: ["g"],
    generation: "g1",
    leaseMs: 5000,
    token: "mutation",
  });
  pending.resolve({ ok: true });
  await writing;
  await wrapped.endWrite({ fences: ["g"], token: "mutation" });
  expect(f.cache.put).not.toHaveBeenCalled();
});

it("does not extend a source deadline while an upstream read or fill is slow", async () => {
  const f = fixture();
  const wrapped = createRegionalStore(f.store, f.options);
  const pending = deferred<ReadResponse>();
  f.read.mockImplementationOnce(() => pending.promise);
  const reading = wrapped.read(f.request);
  await Promise.resolve();
  f.advance(5000);
  pending.resolve({
    kind: "hit",
    epochs: { g: 1 },
    refreshToken: null,
    freshUntil: 101_000,
    value: "1",
  });
  await reading;
  expect(f.cache.put).not.toHaveBeenCalled();
  await wrapped.read(f.request);
  f.advance(4000);
  await wrapped.write(f.fill);
  expect(f.cache.put).not.toHaveBeenCalled();
});

it("shares local invalidation across generations of the same namespace", async () => {
  const f = fixture();
  const current = createRegionalStore(f.store, f.options);
  const next = createRegionalStore(f.store, { ...f.options, generation: "g2" });
  await current.read(f.request);
  await current.write(f.fill);
  expect((await current.read(f.request)).kind).toBe("hit");
  await next.beginWrite({
    fences: ["g"],
    generation: "g2",
    leaseMs: 5000,
    token: "mutation",
  });
  expect((await current.read(f.request)).kind).toBe("miss");
  await next.endWrite({ fences: ["g"], token: "mutation" });
  expect((await current.read(f.request)).kind).toBe("miss");
});

it("shares regional entries between isolates before and after a local mutation", async () => {
  const f = fixture();
  const local = createRegionalStore(f.store, f.options);
  await local.read(f.request);
  await local.write(f.fill);
  vi.resetModules();
  const { createRegionalStore: createPeerStore } = await import(
    "../../src/cloudflare/regional-store"
  );
  const peer = createPeerStore(f.store, f.options);
  expect((await peer.read(f.request)).kind).toBe("hit");
  expect(f.read).toHaveBeenCalledTimes(1);
  await local.invalidate(["g"]);
  expect((await local.read(f.request)).kind).toBe("miss");
  f.advance(1);
  await local.read(f.request);
  await local.write({ ...f.fill, value: '"new"' });
  const reads = f.read.mock.calls.length;
  expect(await peer.read(f.request)).toMatchObject({
    kind: "hit",
    value: '"new"',
    refreshToken: null,
  });
  expect(f.read).toHaveBeenCalledTimes(reads);
});

it("rejects a peer entry created during a local pending write even in the same millisecond", async () => {
  const f = fixture();
  const local = createRegionalStore(f.store, f.options);
  vi.resetModules();
  const { createRegionalStore: createPeerStore } = await import(
    "../../src/cloudflare/regional-store"
  );
  const peer = createPeerStore(f.store, f.options);
  await local.beginWrite({
    fences: ["g"],
    generation: "g1",
    leaseMs: 5000,
    token: "mutation",
  });
  await peer.read(f.request);
  await peer.write({ ...f.fill, value: '"during"' });
  await local.endWrite({ fences: ["g"], token: "mutation" });
  expect((await local.read(f.request)).kind).toBe("miss");
  f.advance(1);
  await local.read(f.request);
  await local.write({ ...f.fill, value: '"fresh"' });
  expect(await local.read(f.request)).toMatchObject({
    kind: "hit",
    value: '"fresh"',
  });
});

it("promotes a verified entity snapshot while retaining every requested epoch", async () => {
  const f = fixture();
  const wrapped = createRegionalStore(f.store, f.options);
  const epochs = { g: 1, "m:Article": 2, "w:Article": 3, "e:Article:one": 4 };
  const request = { ...f.request, fences: Object.keys(epochs) };
  f.read.mockResolvedValueOnce({
    kind: "miss",
    epochs,
    pending: false,
    lockToken: "entity-lock",
    lockHeldForMs: null,
  });
  await wrapped.read(request);
  await wrapped.write({
    ...f.fill,
    lockToken: "entity-lock",
    snapshot: { g: 1, "m:Article": 2, "e:Article:one": 4 },
    value: '{"id":"one"}',
  });
  expect(await wrapped.read(request)).toMatchObject({
    kind: "hit",
    value: '{"id":"one"}',
    epochs,
    refreshToken: null,
  });
  expect(f.read).toHaveBeenCalledTimes(1);
});

const invalidSnapshots: WriteRequest["snapshot"][] = [
  { g: 2 },
  { g: 1, foreign: 9 },
  {},
];
it.each(invalidSnapshots)(
  "does not promote an invalid narrowed snapshot %j",
  async (snapshot) => {
    const f = fixture();
    const wrapped = createRegionalStore(f.store, f.options);
    const epochs = { g: 1, "m:Article": 2, "w:Article": 3 };
    const request = { ...f.request, fences: Object.keys(epochs) };
    f.read.mockResolvedValueOnce({
      kind: "miss",
      epochs,
      pending: false,
      lockToken: "entity-lock",
      lockHeldForMs: null,
    });
    await wrapped.read(request);
    await wrapped.write({ ...f.fill, lockToken: "entity-lock", snapshot });
    expect(f.cache.put).not.toHaveBeenCalled();
  },
);

it("refreshes a near-expiry hit in the background once and reuses the renewal", async () => {
  const f = fixture();
  const tasks: Promise<unknown>[] = [];
  const options = {
    ...f.options,
    waitUntil: (task: Promise<unknown>) => {
      tasks.push(task);
    },
  };
  const first = createRegionalStore(f.store, options);
  const second = createRegionalStore(f.store, options);
  await first.read(f.request);
  await first.write(f.fill);
  f.advance(2000);
  const pending = deferred<ReadResponse>();
  f.read.mockImplementationOnce(() => pending.promise);
  expect(await first.read(f.request)).toMatchObject({
    kind: "hit",
    value: f.fill.value,
  });
  expect(await second.read(f.request)).toMatchObject({
    kind: "hit",
    value: f.fill.value,
  });
  expect(tasks).toHaveLength(1);
  expect(f.read).toHaveBeenCalledTimes(2);
  pending.resolve({
    kind: "hit",
    epochs: { g: 1 },
    refreshToken: null,
    freshUntil: 112_000,
    value: '"renewed"',
  });
  await Promise.all(tasks);
  f.advance(2000);
  expect(await first.read(f.request)).toMatchObject({
    kind: "hit",
    value: '"renewed"',
    refreshToken: null,
  });
  expect(f.read).toHaveBeenCalledTimes(2);
});

it("does not publish a background renewal that overlaps a local write", async () => {
  const f = fixture();
  const tasks: Promise<unknown>[] = [];
  const wrapped = createRegionalStore(f.store, {
    ...f.options,
    waitUntil: (task) => {
      tasks.push(task);
    },
  });
  await wrapped.read(f.request);
  await wrapped.write(f.fill);
  f.advance(2000);
  const pending = deferred<ReadResponse>();
  f.read.mockImplementationOnce(() => pending.promise);
  expect((await wrapped.read(f.request)).kind).toBe("hit");
  await Promise.resolve();
  expect(f.read).toHaveBeenCalledTimes(2);
  await wrapped.beginWrite({
    fences: ["g"],
    generation: "g1",
    leaseMs: 5000,
    token: "mutation",
  });
  pending.resolve({
    kind: "hit",
    epochs: { g: 1 },
    refreshToken: null,
    freshUntil: 112_000,
    value: '"old"',
  });
  await Promise.all(tasks);
  await wrapped.endWrite({ fences: ["g"], token: "mutation" });
  expect(f.cache.put).toHaveBeenCalledTimes(1);
  expect((await wrapped.read(f.request)).kind).toBe("miss");
});

it.each([
  {
    kind: "miss",
    epochs: { g: 1 },
    pending: false,
    lockToken: "fill-lock",
    lockHeldForMs: null,
  } satisfies ReadResponse,
  {
    kind: "hit",
    epochs: { g: 1 },
    refreshToken: "refresh-lock",
    freshUntil: 112_000,
    value: "1",
  } satisfies ReadResponse,
])(
  "releases background coordinator locks without replaying them: $kind",
  async (response) => {
    const f = fixture();
    const tasks: Promise<unknown>[] = [];
    const wrapped = createRegionalStore(f.store, {
      ...f.options,
      waitUntil: (task) => {
        tasks.push(task);
      },
    });
    await wrapped.read(f.request);
    await wrapped.write(f.fill);
    f.advance(2000);
    f.read.mockResolvedValueOnce(response);
    expect(await wrapped.read(f.request)).toMatchObject({
      kind: "hit",
      refreshToken: null,
    });
    await Promise.all(tasks);
    const token =
      response.kind === "hit" ? response.refreshToken : response.lockToken;
    expect(f.release).toHaveBeenCalledWith({
      key: f.request.key,
      lockToken: token,
    });
    expect(f.cache.put).toHaveBeenCalledTimes(1);
  },
);

it("keeps foreground hits safe if scheduling or background reads fail", async () => {
  const f = fixture();
  let rejectedTask: Promise<unknown> | undefined;
  const failedScheduling = createRegionalStore(f.store, {
    ...f.options,
    waitUntil: (task) => {
      rejectedTask = task;
      throw new Error("unavailable");
    },
  });
  await failedScheduling.read(f.request);
  await failedScheduling.write(f.fill);
  f.advance(2000);
  expect((await failedScheduling.read(f.request)).kind).toBe("hit");
  await rejectedTask;
  expect(f.read).toHaveBeenCalledTimes(1);
  const tasks: Promise<unknown>[] = [];
  const wrapped = createRegionalStore(f.store, {
    ...f.options,
    waitUntil: (task) => {
      tasks.push(task);
    },
  });
  f.read.mockRejectedValueOnce(new Error("coordinator unavailable"));
  expect((await wrapped.read(f.request)).kind).toBe("hit");
  await Promise.all(tasks);
  expect((await wrapped.read(f.request)).kind).toBe("hit");
  await Promise.all(tasks);
});

it("repairs a failed end only after acknowledgment and admits a new post-repair fill", async () => {
  const f = fixture();
  const tasks: Promise<unknown>[] = [];
  const wrapped = createRegionalStore(f.store, {
    ...f.options,
    waitUntil: (task) => tasks.push(task),
  });
  await wrapped.read(f.request);
  await wrapped.write(f.fill);
  await wrapped.beginWrite({
    fences: ["g"],
    generation: "g1",
    leaseMs: 5000,
    token: "mutation",
  });
  f.endWrite.mockRejectedValueOnce(new Error("unavailable"));
  await expect(
    wrapped.endWrite({ fences: ["g"], token: "mutation" }),
  ).rejects.toThrow();
  f.advance(999);
  expect((await wrapped.read(f.request)).kind).toBe("miss");
  expect(tasks).toHaveLength(0);
  f.advance(1);
  expect((await wrapped.read(f.request)).kind).toBe("miss");
  expect(tasks).toHaveLength(1);
  await Promise.all(tasks);
  expect(f.endWrite).toHaveBeenLastCalledWith({
    fences: ["g"],
    token: "mutation",
  });
  expect((await wrapped.read(f.request)).kind).toBe("miss");
  f.advance(1);
  await wrapped.read(f.request);
  await wrapped.write({ ...f.fill, value: '"after"' });
  expect(await wrapped.read(f.request)).toMatchObject({
    kind: "hit",
    value: '"after"',
  });
});

it("repairs failed invalidation using the global fence only after acknowledgment", async () => {
  const f = fixture();
  const tasks: Promise<unknown>[] = [];
  const wrapped = createRegionalStore(f.store, {
    ...f.options,
    waitUntil: (task) => tasks.push(task),
  });
  f.invalidate.mockRejectedValueOnce(new Error("unavailable"));
  await expect(wrapped.invalidate(["w:Article"])).rejects.toThrow();
  f.advance(1000);
  await wrapped.read(f.request);
  await Promise.all(tasks);
  expect(f.invalidate).toHaveBeenLastCalledWith(["g"]);
  f.advance(1);
  await wrapped.read(f.request);
  await wrapped.write(f.fill);
  expect((await wrapped.read(f.request)).kind).toBe("hit");
});

it("does not clear a newer invalidation failure when an older repair completes", async () => {
  const f = fixture();
  const tasks: Promise<unknown>[] = [];
  const wrapped = createRegionalStore(f.store, {
    ...f.options,
    waitUntil: (task) => tasks.push(task),
  });
  f.invalidate.mockRejectedValueOnce(new Error("first"));
  await expect(wrapped.invalidate(["w:first"])).rejects.toThrow();
  f.advance(1000);
  const pending = deferred<void>();
  const entered = deferred<void>();
  f.invalidate.mockImplementationOnce(() => {
    entered.resolve();
    return pending.promise;
  });
  await wrapped.read(f.request);
  await entered.promise;
  f.invalidate.mockRejectedValueOnce(new Error("second"));
  await expect(wrapped.invalidate(["w:second"])).rejects.toThrow();
  pending.resolve();
  await Promise.all(tasks);
  await wrapped.read(f.request);
  await wrapped.write(f.fill);
  expect(f.cache.put).not.toHaveBeenCalled();
  f.advance(1000);
  await wrapped.read(f.request);
  await Promise.all(tasks);
  f.advance(1);
  await wrapped.read(f.request);
  await wrapped.write(f.fill);
  expect((await wrapped.read(f.request)).kind).toBe("hit");
});

it("retires an acknowledged token while another mutation remains pending", async () => {
  const f = fixture();
  const tasks: Promise<unknown>[] = [];
  const wrapped = createRegionalStore(f.store, {
    ...f.options,
    waitUntil: (task) => tasks.push(task),
  });
  await wrapped.beginWrite({
    fences: ["g"],
    generation: "g1",
    leaseMs: 5000,
    token: "old",
  });
  f.endWrite.mockRejectedValueOnce(new Error("first"));
  await expect(
    wrapped.endWrite({ fences: ["g"], token: "old" }),
  ).rejects.toThrow();
  f.advance(1000);
  const pending = deferred<void>();
  const entered = deferred<void>();
  f.endWrite.mockImplementationOnce(() => {
    entered.resolve();
    return pending.promise;
  });
  await wrapped.read(f.request);
  await entered.promise;
  await wrapped.beginWrite({
    fences: ["g"],
    generation: "g1",
    leaseMs: 5000,
    token: "new",
  });
  pending.resolve();
  await Promise.all(tasks);
  await wrapped.read(f.request);
  await wrapped.write(f.fill);
  expect(f.cache.put).not.toHaveBeenCalled();
  expect(tasks).toHaveLength(1);
  await wrapped.endWrite({ fences: ["g"], token: "new" });
  f.advance(1);
  await wrapped.read(f.request);
  await wrapped.write(f.fill);
  expect((await wrapped.read(f.request)).kind).toBe("hit");
  expect(
    f.endWrite.mock.calls.filter(([request]) => request.token === "old"),
  ).toHaveLength(2);
  expect(tasks).toHaveLength(1);
});

it("keeps foreground reads fail-closed if repair scheduling throws", async () => {
  const f = fixture();
  let rejectedTask: Promise<unknown> | undefined;
  const wrapped = createRegionalStore(f.store, {
    ...f.options,
    waitUntil: (task) => {
      rejectedTask = task;
      throw new Error("unavailable");
    },
  });
  await wrapped.beginWrite({
    fences: ["g"],
    generation: "g1",
    leaseMs: 5000,
    token: "mutation",
  });
  f.endWrite.mockRejectedValueOnce(new Error("end failed"));
  await expect(
    wrapped.endWrite({ fences: ["g"], token: "mutation" }),
  ).rejects.toThrow();
  f.advance(1000);
  expect((await wrapped.read(f.request)).kind).toBe("miss");
  await rejectedTask;
  expect(f.endWrite).toHaveBeenCalledTimes(1);
  await wrapped.write(f.fill);
  expect(f.cache.put).not.toHaveBeenCalled();
});

it("clears a retained failed end after a successful direct retry", async () => {
  const f = fixture();
  const tasks: Promise<unknown>[] = [];
  const wrapped = createRegionalStore(f.store, {
    ...f.options,
    waitUntil: (task) => tasks.push(task),
  });
  await wrapped.beginWrite({
    fences: ["g"],
    generation: "g1",
    leaseMs: 5000,
    token: "mutation",
  });
  f.endWrite.mockRejectedValueOnce(new Error("end failed"));
  await expect(
    wrapped.endWrite({ fences: ["g"], token: "mutation" }),
  ).rejects.toThrow();
  await wrapped.endWrite({ fences: ["g"], token: "mutation" });
  f.advance(1001);
  await wrapped.read(f.request);
  await wrapped.write(f.fill);
  expect((await wrapped.read(f.request)).kind).toBe("hit");
  expect(tasks).toHaveLength(0);
});

it("deduplicates repair and backs off after an unsuccessful retry", async () => {
  const f = fixture();
  const tasks: Promise<unknown>[] = [];
  const wrapped = createRegionalStore(f.store, {
    ...f.options,
    waitUntil: (task) => tasks.push(task),
  });
  await wrapped.beginWrite({
    fences: ["g"],
    generation: "g1",
    leaseMs: 5000,
    token: "mutation",
  });
  f.endWrite.mockRejectedValueOnce(new Error("end failed"));
  await expect(
    wrapped.endWrite({ fences: ["g"], token: "mutation" }),
  ).rejects.toThrow();
  f.advance(1000);
  let rejectRepair!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, reject) => {
    rejectRepair = reject;
  });
  const entered = deferred<void>();
  f.endWrite.mockImplementationOnce(() => {
    entered.resolve();
    return pending;
  });
  await wrapped.read(f.request);
  await entered.promise;
  await wrapped.read(f.request);
  expect(tasks).toHaveLength(1);
  rejectRepair(new Error("retry failed"));
  await Promise.all(tasks);
  f.advance(999);
  await wrapped.read(f.request);
  expect(tasks).toHaveLength(1);
  f.advance(1);
  await wrapped.read(f.request);
  await Promise.all(tasks);
  expect(tasks).toHaveLength(2);
});

it("retains an independent copy of a failed end request", async () => {
  const f = fixture();
  const tasks: Promise<unknown>[] = [];
  const wrapped = createRegionalStore(f.store, {
    ...f.options,
    waitUntil: (task) => tasks.push(task),
  });
  await wrapped.beginWrite({
    fences: ["g"],
    generation: "g1",
    leaseMs: 5000,
    token: "mutation",
  });
  const request = { fences: ["g"], token: "mutation" };
  f.endWrite.mockImplementationOnce(async (value) => {
    value.fences.push("changed");
    throw new Error("end failed");
  });
  await expect(wrapped.endWrite(request)).rejects.toThrow();
  request.fences.push("caller-change");
  f.advance(1000);
  await wrapped.read(f.request);
  await Promise.all(tasks);
  expect(f.endWrite).toHaveBeenLastCalledWith({
    fences: ["g"],
    token: "mutation",
  });
});

it("allows an idempotent begin retry with the same token and resumes caching after end", async () => {
  const f = fixture();
  const wrapped = createRegionalStore(f.store, f.options);
  const request = {
    fences: ["g"],
    generation: "g1",
    leaseMs: 5000,
    token: "mutation",
  };
  await wrapped.beginWrite(request);
  await wrapped.beginWrite(request);
  await wrapped.endWrite({ fences: ["g"], token: request.token });
  f.advance(1);
  await wrapped.read(f.request);
  await wrapped.write(f.fill);
  expect((await wrapped.read(f.request)).kind).toBe("hit");
  expect(f.beginWrite).toHaveBeenCalledTimes(2);
});

it("keeps regional caching blocked if a failed-end token is reused for a new begin", async () => {
  const f = fixture();
  const wrapped = createRegionalStore(f.store, f.options);
  const request = {
    fences: ["g"],
    generation: "g1",
    leaseMs: 5000,
    token: "mutation",
  };
  await wrapped.beginWrite(request);
  f.endWrite.mockRejectedValueOnce(new Error("end failed"));
  await expect(
    wrapped.endWrite({ fences: ["g"], token: request.token }),
  ).rejects.toThrow();
  await wrapped.beginWrite(request);
  await wrapped.endWrite({ fences: ["g"], token: request.token });
  f.advance(1001);
  await wrapped.read(f.request);
  await wrapped.write(f.fill);
  expect(f.cache.put).not.toHaveBeenCalled();
});

it("blocks regional caching while overlapping begins for one token are serialized", async () => {
  const f = fixture();
  const wrapped = createRegionalStore(f.store, f.options);
  await wrapped.read(f.request);
  await wrapped.write(f.fill);
  expect((await wrapped.read(f.request)).kind).toBe("hit");

  const request = {
    fences: ["g"],
    generation: "g1",
    leaseMs: 5000,
    token: "mutation",
  };
  const firstEntered = deferred<void>();
  const secondEntered = deferred<void>();
  const second = deferred<void>();
  let rejectFirst!: (error: Error) => void;
  const first = new Promise<void>((_resolve, reject) => {
    rejectFirst = reject;
  });
  f.beginWrite
    .mockImplementationOnce(() => {
      firstEntered.resolve();
      return first;
    })
    .mockImplementationOnce(() => {
      secondEntered.resolve();
      return second.promise;
    });
  const firstBegin = wrapped.beginWrite(request);
  const firstRejected =
    expect(firstBegin).rejects.toThrow("first begin failed");
  const secondBegin = wrapped.beginWrite(request);
  await firstEntered.promise;
  expect(f.beginWrite).toHaveBeenCalledTimes(1);
  expect((await wrapped.read(f.request)).kind).toBe("miss");
  await wrapped.write(f.fill);
  expect(f.cache.put).toHaveBeenCalledTimes(1);
  rejectFirst(new Error("first begin failed"));
  await firstRejected;
  await secondEntered.promise;
  expect((await wrapped.read(f.request)).kind).toBe("miss");
  await wrapped.write(f.fill);
  expect(f.cache.put).toHaveBeenCalledTimes(1);
  second.resolve();
  await secondBegin;
  expect((await wrapped.read(f.request)).kind).toBe("miss");
  await wrapped.endWrite({ fences: ["g"], token: request.token });
  f.advance(1);
  await wrapped.read(f.request);
  await wrapped.write({ ...f.fill, value: "new" });
  expect(await wrapped.read(f.request)).toMatchObject({
    kind: "hit",
    value: "new",
  });
});

it("waits for an earlier begin before ending the same token", async () => {
  const f = fixture();
  const wrapped = createRegionalStore(f.store, f.options);
  const entered = deferred<void>();
  const pending = deferred<void>();
  f.beginWrite.mockImplementationOnce(() => {
    entered.resolve();
    return pending.promise;
  });
  const request = {
    fences: ["g"],
    generation: "g1",
    leaseMs: 5000,
    token: "mutation",
  };
  const begin = wrapped.beginWrite(request);
  await entered.promise;
  const end = wrapped.endWrite({ fences: ["g"], token: request.token });
  expect(f.endWrite).not.toHaveBeenCalled();
  expect((await wrapped.read(f.request)).kind).toBe("miss");
  await wrapped.write(f.fill);
  expect(f.cache.put).not.toHaveBeenCalled();
  pending.resolve();
  await begin;
  await end;
  expect(f.endWrite).toHaveBeenCalledTimes(1);
  f.advance(1);
  await wrapped.read(f.request);
  await wrapped.write(f.fill);
  expect((await wrapped.read(f.request)).kind).toBe("hit");
});

it("serializes a reused token behind a failed-end repair and remains fail-closed", async () => {
  const f = fixture();
  const tasks: Promise<unknown>[] = [];
  const wrapped = createRegionalStore(f.store, {
    ...f.options,
    waitUntil: (task) => tasks.push(task),
  });
  const request = {
    fences: ["g"],
    generation: "g1",
    leaseMs: 5000,
    token: "mutation",
  };
  await wrapped.beginWrite(request);
  f.endWrite.mockRejectedValueOnce(new Error("end failed"));
  await expect(
    wrapped.endWrite({ fences: ["g"], token: request.token }),
  ).rejects.toThrow();
  f.advance(1000);
  const entered = deferred<void>();
  const pending = deferred<void>();
  f.endWrite.mockImplementationOnce(() => {
    entered.resolve();
    return pending.promise;
  });
  await wrapped.read(f.request);
  await entered.promise;
  const begin = wrapped.beginWrite(request);
  expect(f.beginWrite).toHaveBeenCalledTimes(1);
  pending.resolve();
  await Promise.all(tasks);
  await begin;
  await wrapped.endWrite({ fences: ["g"], token: request.token });
  f.advance(1);
  await wrapped.read(f.request);
  await wrapped.write(f.fill);
  expect(f.cache.put).not.toHaveBeenCalled();
});

it("keeps token serialization after a repair deadline until its RPC settles", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    const tasks: Promise<unknown>[] = [];
    const wrapped = createRegionalStore(f.store, {
      ...f.options,
      waitUntil: (task) => tasks.push(task),
    });
    const request = {
      fences: ["g"],
      generation: "g1",
      leaseMs: 5000,
      token: "mutation",
    };
    await wrapped.beginWrite(request);
    f.endWrite.mockRejectedValueOnce(new Error("end failed"));
    await expect(
      wrapped.endWrite({ fences: ["g"], token: request.token }),
    ).rejects.toThrow();
    f.advance(1000);
    const entered = deferred<void>();
    const pending = deferred<void>();
    f.endWrite.mockImplementationOnce(() => {
      entered.resolve();
      return pending.promise;
    });
    await wrapped.read(f.request);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all(tasks);
    f.advance(1000);
    await wrapped.read(f.request);
    await Promise.all(tasks);
    expect(f.endWrite).toHaveBeenCalledTimes(2);
    const end = wrapped.endWrite({ fences: ["g"], token: request.token });
    expect(f.endWrite).toHaveBeenCalledTimes(2);
    expect((await wrapped.read(f.request)).kind).toBe("miss");
    pending.resolve();
    await end;
    expect(f.endWrite).toHaveBeenCalledTimes(3);
    f.advance(1);
    await wrapped.read(f.request);
    await wrapped.write(f.fill);
    expect((await wrapped.read(f.request)).kind).toBe("hit");
  } finally {
    vi.useRealTimers();
  }
});

it("retries a timed-out renewal and releases its late lock", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    const tasks: Promise<unknown>[] = [];
    const wrapped = createRegionalStore(f.store, {
      ...f.options,
      waitUntil: (task) => tasks.push(task),
    });
    await wrapped.read(f.request);
    await wrapped.write(f.fill);
    f.advance(2000);
    const late = deferred<ReadResponse>();
    const entered = deferred<void>();
    f.read.mockImplementationOnce(() => {
      entered.resolve();
      return late.promise;
    });
    expect((await wrapped.read(f.request)).kind).toBe("hit");
    await entered.promise;
    expect((await wrapped.read(f.request)).kind).toBe("hit");
    expect(tasks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all(tasks);
    f.read.mockResolvedValueOnce({
      kind: "hit",
      value: '"renewed"',
      epochs: { g: 1 },
      refreshToken: null,
      freshUntil: 112_000,
    });
    expect((await wrapped.read(f.request)).kind).toBe("hit");
    expect(tasks).toHaveLength(2);
    await Promise.all(tasks);
    late.resolve({
      kind: "miss",
      epochs: { g: 1 },
      pending: false,
      lockToken: "late-lock",
      lockHeldForMs: null,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.release).toHaveBeenCalledWith({
      key: f.request.key,
      lockToken: "late-lock",
    });
    f.advance(2000);
    expect(await wrapped.read(f.request)).toMatchObject({
      kind: "hit",
      value: '"renewed"',
    });
  } finally {
    vi.useRealTimers();
  }
});
