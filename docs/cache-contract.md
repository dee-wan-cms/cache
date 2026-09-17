# Cache Contract — Cloudflare

Status: active. Store: one SQLite-backed Durable Object (DO) per coordinator name.

## Goal

Cache Prisma reads on Workers + D1. Never serve pre-write data after a committed write in the same
request flow. Fail to the database, never to stale cache.

## Store choice

- Epochs, leases, fill locks and values live in ONE Durable Object.
- Reason: check-and-write must be atomic. DO storage is transactional and strongly consistent.
- Cache API rejected: one data center only, `cache.delete` is local, no compare-and-set.
- KV rejected: eventually consistent (60 s+), 1 write/s per key.
- One DO has a soft limit of 1,000 requests/s. Every cached read and every write calls it.
- One DO has one location. Hit latency = round trip to it. Coordinator far from users: hits slower than
  a nearby D1 read (measured 171–210 ms vs 48–103 ms). Place it near most traffic (`locationHint`).
- Coordinator name is required. Keys do not include the database. Two databases with the same schema
  behind one coordinator name share entries: data leak.
- Exactly one coordinator name per D1 database. Two coordinators over the same data never see each
  other's writes: stale reads.

## Fences

```text
g               global
m:<Model>       model-wide
w:<Model>       any write to model
e:<Model>:<pk>  one entity
```

- Fence = named row in the DO. Missing = 0. Bump = next value of one DO-wide sequence. A value is
  never reused, so a deleted row can never make an old snapshot match again.
- Entity fence rows (`e:`) are collected when: last bump older than 10 min (2 × max lock), no cached
  entry references it, no lease names it.
- Collection pages through `e:` rows in `(updated_at, fence)` order with a stored cursor, at most 100
  rows per call, one indexed query that also checks references. The cursor returns to the start when a
  batch comes back short.
- Deleting rows raises a watermark to the highest epoch deleted. A fill whose snapshot has a missing
  fence (0) and whose lock sequence is below the watermark is rejected. Only a row bumped after the lock
  can raise it that high, so this holds even if the clock moves backwards.

## Read

```text
batch $transaction([...]) -> no cache (Prisma waits for every batch member to reach the engine)
targets = root + every model reached by include, select, _count, relation filter, orderBy, cursor
relation depth > 10 -> no cache
any target model opted out (@cache.skip, exclude, excludeModels) -> no cache
key = sha256(planner version, cacheVersion, scope, model, operation, fluent data path, args)
DO.read(key, fences = g, m:root, w:each target, e:root:pk when findUnique by pk)
hit  -> entry snapshot equals current epochs -> return value
miss -> fill lock granted when no open lease on requested fences and no live fill lock
lock -> query D1 -> DO.write(key, lock, snapshot) -> return value
lock held by a fill -> poll 20,40,80,160,320,640 ms; stop at once and query D1 when the holder has
  held it longer than the whole poll budget
lease open -> query D1, no write
DO error -> query D1
```

Snapshot:

```text
findUnique by pk, no relation walked, non-null result -> g, m:root, e:root:pk
self-relations count as walked
everything else (lists, counts, nulls, relations) -> all requested fences
```

- Reads never sweep. A hit writes nothing unless it takes a refresh lock or sees a new generation.
- A refresh lock (SWR) yields to a fill once the entry is gone; the refill then loses its lock.
- Write check: lock token must match and be live; snapshot must equal current epochs.
- Invalid or expired entries found on read are deleted.

## Write

```text
plan fences from args (no result needed)
DO.beginWrite(client token): bump plan fences, open lease (default 60 s)
beginWrite fails -> send endWrite with the same token, throw CacheUnavailableError, D1 write NOT run
run D1 write
DO.endWrite (always, success or error): bump again, close lease, delete up to 500 entries under the
  fences, sweep
```

- Begin bump + lease: no reader serves or caches pre-write state while the write runs.
- End bump: a reader that filled after lease expiry but before commit loses.
- End lost and lease open: readers skip caching until the lease expires.
- End lost and lease expired before commit: a reader can cache pre-commit data until that entry's TTL
  (default fresh TTL 1 h). Only `onError` reports the lost end.
- Retryable DO errors (`retryable` and not `overloaded`) on begin, end and invalidate are retried by the
  store, 3 attempts total, fresh stub, backoff. Reads and fill writes are not retried.

Plan rules:

```text
create / createMany*                    w:root
update / upsert / delete, where has pk  e:root:pk + w:root
same, no pk in where                    m:root + w:root
updateMany / deleteMany                 m:root + w:root
delete* on X                            m + w of every model with FK to X, transitive
update data touches a referenced field  same widening
nested connect/disconnect/delete/update/upsert/connectOrCreate by pk -> entity, else model-wide
nested create/createMany                w
nested set / unknown op                 model-wide
nested updateMany changing a referenced key            widen referencing models
nested op changing an FK column that another FK references   widen referencing models
one-to-one connect/create/connectOrCreate/upsert       m + w of both sides
more than 100 entities of one model     model-wide
named compound key (@@id(name: ...))    matched by name
nesting depth >= 5                      g
```

## Keys and scope

- Key includes `scope`. A client extended per caller passes a scope naming everything the caller
  changes about results without changing arguments.
- Fences are shared across scopes: data is shared.
- Fluent calls (`findUnique().posts()`) and direct calls with the same arguments get different keys.
- Class-instance arguments (Prisma `DbNull`, `JsonNull`, `AnyNull`) hash with their class string.
- Own `__proto__` keys in arguments and values are kept.
- Client construction options that change results (for example global `omit`) are not in the key.
  Clients built with different options pass different scopes.
- Prisma 6.19.3: first applied `$extends` is outermost (proven in `test/workerd`).
- Required order: guard first, cache second (`base.$extends(guard).$extends(cache)`). Guard runs on
  every read including hits; its rewritten arguments are in the key.

## Generation

- The extension always sends `planner version / cacheVersion / generation option`.
- DO stores the last value. A different value bumps `g` once. No entries are deleted: they fail the
  snapshot check and expire or get evicted.
- A schema change (new `cacheVersion`) or a package release with new planning rules therefore
  invalidates every entry on first contact.
- Every Worker bound to one coordinator must send the same value. Different values alternating (two
  scripts on different versions, a gradual deployment) bump `g` on every switch: correct, cache cold.
- Option `generation` (1..256 chars): change it when turning `enabled` back on and after any data
  change made outside the cache.
- A disabled version running beside an enabled one is unsafe: its writes are not fenced.

## Storage

- Schema versioned in `schema_version`. Migrations run in the DO constructor, all pending ones in one
  transaction. Storage newer than the code throws on every call, so every Prisma write fails with
  `CacheUnavailableError`. Roll forward, never back, across a schema change.
- Every coordinator call runs in one storage transaction (`transactionSync`).
- Stored entry bytes are counted. Default budget 1 GiB. A fill write that would exceed it evicts the
  entries closest to expiry (up to 1,000 per write); if still over, the write returns `full`.
- Sweeps run on fill writes, end of write and invalidate: up to 50 expired entries, leases and locks,
  then fence collection.
- Limits enforced on every call: key 1..1024 chars, at most 5,000 fences of up to 512 chars, generation
  up to 512 chars, lock up to 5 min, lease up to 10 min. Fill writes also refuse values over 1,900,000
  bytes and TTLs over 366 days (`invalid`). Malformed requests throw.
- Requests may gain fields in minor releases, never lose or retype them.
- Generated config carries `configFormat`. The extension refuses another format and asks to run
  `prisma generate`.
- Not handled: a `beginWrite` delivered after the client gave up and sent end. Its lease blocks caching
  for those fences until it expires (default 60 s). It cannot serve stale data. Whether Cloudflare can
  deliver such a call late is not known.

## Raw writes

Raw SQL bypasses the extension. Use one:

- `$cacheRawWrite(target, run)`: lease + bumps around `run`. Preferred.
- `$cacheInvalidate(target)`: bump + delete after the fact. The window between commit and call can
  serve old data. Calls the coordinator even when `enabled` is false.

Target: `{ models }`, `{ entities: [{ model, pk: [...] }] }`, `{ all: true }`. Models referencing a
target through a foreign key are widened. Unknown model names throw. Wrong key arity widens to the model.

## Cost per Prisma call

```text
cached read, hit                   1 DO call
cached read, miss                  1 DO call + D1 queries + 1 DO call (fill write or release)
cached read, fill lock contended   up to 7 DO calls (polls) + D1 queries when the holder is slow
read in a batch transaction        D1 queries only
non-cacheable read                 D1 queries only
write                              2 DO calls + D1 queries; each retried up to 3 attempts
```

- Workers Free plan: 50 subrequests per request; the limits page also lists 1,000 for internal
  services. Whether DO and D1 calls count toward the 50 or the 1,000 is not stated there.
- Every write moves `w:<Model>`: lists, counts and relation reads of that model are invalidated.
- Read load and write load share one DO. An overloaded DO refuses writes (`CacheUnavailableError`).

## Options

Rejected at construction:

- `lockMs` outside (0, 300000]; `leaseMs` outside (0, 600000]; `maxValueBytes` outside (0, 1900000]
- negative poll delays
- unknown `excludeModels`
- shape TTLs outside (0, 28747636] s (366 days minus jitter headroom); `softTtlRatio` outside (0, 1]
- missing `decimal` when the schema has Decimal fields
- `generation` longer than 256 chars
- config of another `configFormat`

## Switches

- Generator: every model cacheable. `/// @cache.skip` on a model or `exclude = [...]` opts out.
- Opted-out models still move fences on write, and reads that include them are not cached.
- Runtime `enabled: false`: reads and writes bypass the DO (`$cacheInvalidate` still calls it).

## SWR

- Entry soft TTL = ttl × softTtlRatio.
- Hit past soft TTL, `waitUntil` given, no open lease, no live lock -> refresh lock -> refill in
  `waitUntil` with the hit's epochs. Without `waitUntil` the refresh lock is released at once.
- Refill obeys the normal write check. SWR only refreshes valid entries.

## D1 constraints

- Prisma 6.19.3 on D1 rejects interactive `$transaction(async tx => ...)`; the test shows no data change.
- Batch `$transaction([...])` runs; each query commits alone. Reads in a batch skip the cache; writes are
  fenced one by one.
- Read replicas through `withSession` "first-unconstrained" can cache lagging data. Not supported.

## From the Redis module

Kept: fence/epoch invalidation, entity vs model vs write fences, predicate rules, fill lock
single-flight, CAS-style write check, explicit raw-write invalidation, raw result shape.

Changed: pub/sub and local marks replaced by DO state per request; sorted-set indexes replaced by
`entry_fences`; PK injection removed; pre-write lease added; cascade widening added;
`neverInvalidateOn` dropped.

Not ported (owner decisions, 2026-09-17): stale shadow (serves pre-write data), Redis adapter,
warming and repair (depended on the removed hot-query tracker).

## Verify

- `npm run test:unit` (Node, `node:sqlite` stand-in for DO SQL): coordinator core, protocol model
  (random interleavings), planning, targets, codec, extension failure paths, store options, generator.
- `npm run test:workerd` (Miniflare; two Worker scripts sharing D1 and the DO; real Prisma 6.19.3 +
  adapter-d1): invalidation, relations, self-relations, one-to-one, cascade, nested writes, stampede,
  races, leases, scope, raw writes, opt-out, switch, generation, DO unavailable, cross-script
  invalidation, SWR, stored types, batch and interactive transactions, fluent reads, extension order.
- `npm run test:consumer`: packed tarball in a fresh Worker project: generator bin, types, wrangler
  bundle, fill/hit/invalidation on workerd.
- Deployed smoke (`test/deployed`, see README): a temporary Worker, D1 and DO on a real account.
