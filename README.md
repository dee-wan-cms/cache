# @dee-wan/cache

Prisma read cache for Cloudflare Workers and D1. A Durable Object coordinates invalidation, fill locks
and cached values, so a write through one Worker is seen by every other Worker on its next read.

The contract, including every invalidation rule and limit, is in
[docs/cache-contract.md](docs/cache-contract.md).

## Generate the config

```prisma
generator cache {
  provider = "dee-wan-cache-generator"
  output   = "../src/generated/cache"
  exclude  = ["AuditLog"]   // optional
}

/// @cache.skip
model Session {
  id String @id
}
```

Run `npx prisma generate` (or an npm script that runs `prisma generate`) to write `cache-config.ts`.
The provider name resolves through `node_modules/.bin`, so the Prisma binary must run with npm's `PATH`.
Every model is cacheable unless it carries `/// @cache.skip` or is listed in `exclude`. Reads that
include an opted-out model are not cached. Regenerate after upgrading this package: the extension
refuses a config of another format.

## Wire it into a Worker

```ts
import { PrismaD1 } from "@prisma/adapter-d1";
import { createCacheExtension } from "@dee-wan/cache";
import { createDurableObjectStore } from "@dee-wan/cache/cloudflare";
import { cacheConfig } from "./generated/cache/cache-config";
import { Prisma, PrismaClient } from "./generated/prisma";

export { CacheCoordinator } from "@dee-wan/cache/cloudflare";

export default {
  async fetch(request, env, ctx) {
    const prisma = new PrismaClient({ adapter: new PrismaD1(env.DB) }).$extends(
      createCacheExtension({
        config: cacheConfig,
        decimal: Prisma.Decimal,
        enabled: env.CACHE_ENABLED !== "false",
        generation: env.CACHE_GENERATION,
        scope: "public",
        store: createDurableObjectStore(env.CACHE_COORDINATOR, { name: "main-db" }),
        waitUntil: (promise) => ctx.waitUntil(promise),
      }),
    );
    // ...
  },
} satisfies ExportedHandler<Env>;
```

```jsonc
{
  "durable_objects": { "bindings": [{ "name": "CACHE_COORDINATOR", "class_name": "CacheCoordinator" }] },
  "migrations": [{ "tag": "cache-v1", "new_sqlite_classes": ["CacheCoordinator"] }]
}
```

Prisma runs query extensions outermost-first in the order they were applied (verified on Prisma 6.19.3).
Apply per-caller extensions such as prisma-guard before the cache:

```ts
const client = base.$extends(guardFor(caller)).$extends(createCacheExtension({ ...options, scope }));
```

They then run on every read, including hits, and the arguments they rewrite (for example a tenant
filter) are part of the cache key. An extension applied after the cache is skipped on a hit. Use
`scope` for anything a caller changes about results without changing the arguments.

## Options

Invalid options throw a `TypeError` at construction.

| Option | Default | Meaning |
|---|---|---|
| `config` | — | Generated config. |
| `store` | — | `createDurableObjectStore(namespace, { name, attempts?, locationHint? })`. |
| `decimal` | none | `Prisma.Decimal`. Required when the schema has Decimal fields. |
| `enabled` | `true` | `false`: reads and writes skip the coordinator. `$cacheInvalidate` still calls it. |
| `scope` | `""` | Part of every key. |
| `generation` | none | 1..256 chars, the same for every Worker bound to the coordinator. Changing it invalidates every entry once. |
| `excludeModels` | `[]` | Runtime opt-out on top of the generated config. |
| `shape` | fresh 3600 s, negative 600 s, soft ratio 0.8 | `{ default, byModel }`. TTLs must be at most 28,747,636 s. |
| `waitUntil` | none | Enables refresh after the soft TTL. |
| `leaseMs` | 60000 | Write lease, at most 600000. |
| `lockMs` | 30000 | Fill lock, at most 300000. |
| `fillPollDelaysMs` | 20, 40, 80, 160, 320, 640 | Waits while another request fills the same key. Readers stop waiting once the holder has held the lock longer than the whole budget. |
| `maxValueBytes` | 1500000 | Larger results are served but not cached. At most 1900000. |
| `onError` | none | Receives coordinator, serialization and write errors. |

`createDurableObjectStore(namespace, { name, attempts, locationHint })`:

- `name` (required) identifies the D1 database. Keys do not include the database, so two databases
  sharing one coordinator name would share cached rows. Use one name per database.
- `attempts` (default 3, at most 10) is the total number of tries for retryable coordinator errors on
  begin, end and invalidate.
- `locationHint` (`wnam`, `enam`, `sam`, `weur`, `eeur`, `apac`, `oc`, `afr`, `me`) places the
  coordinator on first creation, best effort.

## Raw SQL writes

Raw SQL does not pass through the extension. Wrap it:

```ts
await prisma.$cacheRawWrite({ models: ["Post"] }, () => env.DB.prepare("UPDATE Post SET ...").run());
await prisma.$cacheInvalidate({ entities: [{ model: "Post", pk: [42] }] });
await prisma.$cacheInvalidate({ all: true });
```

Models that reference the target through a foreign key are invalidated too. Unknown model names throw.

## Behaviour to plan for

- Coordinator unreachable on a read: the read goes to D1 and nothing is cached.
- Coordinator unreachable or overloaded before a write: `CacheUnavailableError` is thrown and the write
  does not run. Cache reads and writes share one coordinator, so heavy read load can refuse writes.
- Writes made while `enabled: false` are not tracked. Change `generation` when turning the cache back
  on, or call `$cacheInvalidate({ all: true })`. Never run a disabled and an enabled version together.
- A new schema or package version invalidates every entry on first contact. Workers of different
  versions bound to one coordinator keep invalidating each other until one version remains.
- Rolling back to a release with an older coordinator storage schema makes every write fail with
  `CacheUnavailableError`. Roll forward.
- Reads inside batch `$transaction([...])` are not cached. Prisma's D1 adapter rejects interactive
  transactions.
- Reads through D1 `withSession` replicas are not supported.
- One coordinator Durable Object has a soft limit of 1,000 requests per second. Measured on
  2026-09-17 from one client: about 1,030 cached reads per second at 21 ms p50 with no errors, against
  about 340 per second at 215 ms reading D1 directly. Higher rates are not measured.
- Each cached hit costs one coordinator call; a miss costs two; a contended miss can cost up to seven;
  each write costs two, plus retries. On the Workers Free plan, requests that make many Prisma calls
  can reach the subrequest limit (see the contract, "Cost per Prisma call").
- Every write to a model invalidates that model's cached lists, counts and relation reads.
- Cached entries are capped at 1 GiB per coordinator; the entries closest to expiry are evicted first.
- Every cached read makes a round trip to the one coordinator location. Measured from Asia on
  2026-09-17: hits took 8–14 ms with the coordinator in `apac` and 171–210 ms with it in `weur`, slower
  than reading a nearby D1 directly (48–103 ms). Place the coordinator near most traffic with
  `locationHint`; users far from it can get slower reads than without the cache.

## Runtime requirements

- Cloudflare Workers with a SQLite-backed Durable Object and D1. No `nodejs_compat` needed.
- Prisma 6.19.3 or newer 6.x with `@prisma/adapter-d1` (tested with 6.19.3).
- Generator: Node 20 or newer (CI runs it on 20, 22 and 24). Wrangler 4 and Miniflare need Node 22.

## Development

```sh
npm run build
npm run lint
npm run typecheck        # builds, generates the test client, then checks src and tests
npm run test:unit        # Node 22.5+ (node:sqlite)
npm run test:workerd
npm run test:consumer    # packs, installs into a fresh Worker project, runs it on workerd
```

Deployed smoke (only on a disposable account; the test Worker runs arbitrary SQL for callers holding
the token):

```sh
npm run test:prepare
npx wrangler d1 create <name>                       # put the id into a copy of test/deployed/wrangler.example.jsonc
npx wrangler d1 execute <name> --remote --file test/workerd/.build/schema.sql
npx wrangler deploy -c <copy> --var SMOKE_TOKEN:<random>
CACHE_SMOKE_URL=https://<worker> CACHE_SMOKE_TOKEN=<random> npm run test:deployed
npx wrangler delete --name <worker> && npx wrangler d1 delete <name>
```

`test/workerd/.build/schema.sql` is written by `npm run test:workerd`.

## D1 write fencing with guarded Prisma reads

`@dee-wan/cache/d1` exports `cacheD1Env`, `wrapD1Handler`, `createD1CacheRuntime`,
`d1PrismaCacheExtension`, and `fenceD1Writes`. A consumer provides a `D1CacheProfile`
with environment prefix, D1 binding names and prefixes, coordinator object-name prefix,
Prisma `readModels`, and explicitly proven `unfencedWriteTables`. The write adapter
passes reads straight through and fences raw D1 writes, including batches, exec, and
sessions. Unknown or ambiguous writes use the global fence. Exempt a table only when
its schema proves that its writes cannot change cached data through triggers or cascades.

Wrap every fetch, scheduled handler, and separate writer that can touch a coordinated
D1 database. Apply `d1PrismaCacheExtension` to a client only after its authorization and
scope extensions. The runtime returns no extension when caching or cached reads are
staged off. Independent control and authentication clients should remain uncached.
`@dee-wan/cache/d1/config` validates Worker bindings, database identity maps, and paired
writers, and offers generic writer configuration edits. Consumers must supply real D1
UUIDs, never binding object identities.

`coordinationGeneration` lets a Prisma extension share the literal coordinator generation
with a raw-D1 write fence during an upgrade. If omitted, the existing planner/config-derived
coordinator generation remains unchanged. Prisma cache keys always contain planner and
generated-config versions. Do not mix coordination generations on one coordinator; staged
rollouts must make every writer participate before enabling cached reads. External D1 writes
are not intercepted: disable cached reads and writers as appropriate, then use a fresh
generation before re-enabling caching.

The package's Prisma peer support remains Prisma 6.19.3 and later 6.x. The D1 write adapter
is independent of Prisma; other Prisma versions have not been validated by this package.

### Explicit authorized reads

`d1CacheEpoch(database)` returns an opaque namespace for a wrapped database's identity,
generation and global write epoch. Capture it before reading that database and include
every dependency's captured namespace in an external cache key. A missing runtime,
disabled reads, pending write or coordinator failure returns `null`; bypass external
cache reads and fills in that case. Old in-flight fills retain their old namespace.
This does not authorize a request or invalidate downstream browser caches.

`cacheD1Read(database, { key, scope, dependencies, ttlMs, cacheable }, load)` caches an
explicitly selected read after the caller has completed authorization. Include the full
actor, site, current permissions and all query inputs in `scope` and `key`, and list every
physical D1 binding read by the loader in `dependencies`. The helper inspects each unique
binding's global fence before lookup, includes its generation and epoch in the key, and
checks again before serving a hit or storing a fill. A pending write, unknown runtime,
older coordinator, inspection failure, or disabled reads bypasses the cache. Default TTL
is 30 seconds, with a maximum of five minutes. Values and keys are bounded; unsupported
objects bypass caching. Date, bigint and byte arrays use the existing value codec.

`cacheD1JsonRead(database, { key, scope, dependencies, ttlMs, request, buffered: true }, load)`
is an explicit opt-in for responses the caller knows are buffered JSON. It keeps the
original response on a miss and preserves response headers on a hit. Conditional, range,
preview and capability requests, error responses, cookies, downloads, unsafe `Vary`,
encoded bodies and oversized bodies bypass caching. Without `buffered: true`, responses
bypass; never set it for streams. Response buffering is byte-bounded and time-bounded.
These helpers use private Durable Object storage, not the public Cache API.

For native Prisma reads that also depend on another D1 database, use
`withD1PrismaCache(client, database, config, { scope, dependencies })` after the caller's
guards. Scope must include the complete actor, site and permission context. Per-operation
keys include dependency epochs and recheck dependencies on hits. The original three-argument
form retains its existing behavior. All participating writers must fence through the same
physical-database coordinator.

D1 coordinator calls have a 2-second deadline each. Reads fall back to D1 on failure;
writes require a successful begin. A failed end preserves the database result and keeps
the lease conservative. Late begins and read locks are cleaned up after they settle.

`keyArgs` optionally maps read arguments to cache-key identity. Preserve every result-changing input in that identity. Execution and invalidation use the original arguments. Callback errors bypass the cache.

### Regional read cache

`cacheD1Read` and scoped `d1PrismaCacheExtension` / `withD1PrismaCache` accept `regionalTtlMs` from 0 to 5000. The default is 0 (strict coordination). A positive value opts in to bounded stale results in the local Cloudflare Cache API; changes by other writers may remain invisible for up to that interval. Use 0 for a strict read. Cache API failure falls back to the strict path. This option caches values, not HTTP responses.

Keys include database and coordinator identities, generations, scope, and query identity. `regionalModels` optionally limits Prisma regional reads to queries whose root and all related models are listed. Callers must supply a scope that separates every authorization context affecting the result. `keyArgs` must preserve every result-changing argument. For custom `createD1CacheRuntime` stores, supply a stable, unique `regionalIdentity` per coordinator; without one the regional layer is bypassed.

`cacheRegionalResponse(request, { namespace, ttlMs, waitUntil? }, load)` is an opt-in regional cache for anonymous public GET JSON responses. Use a stable deployment/version namespace and a TTL no greater than 5000 ms. Credential, preview, conditional and cache-bypass requests reach `load`. Only explicitly public responses with positive `s-maxage` qualify. Browser responses require revalidation; the internal expiry remains bounded from the start of `load`. Cache API errors fall back to `load`. Callers must apply this only to public routes and must include every response-varying request input in the request or namespace.

`wrapD1ReadResponseLease(handler, profile)` from `@dee-wan/cache/d1/response-lease` optionally reuses authenticated GET responses. Set `readResponseLease.maxSeconds` from 1 to 300 (default 5), and explicitly set `<PREFIX>_READ_ACCESS_SECONDS` from 1 to that maximum (default 0). Wrap it inside `wrapD1Handler`. JSON response bodies are validated at fill up to 8,000,000 raw bytes; hits stream the cached body without decoding and preserve client headers. Ordinary regional read values remain capped at 1,500,000 bytes. The profile supplies the database binding, deployment environment variable, admitted paths, credential and vary headers, and a freshness-cookie name. A `*` path segment matches one nonempty segment. Keys include the full request URL, configured credential and vary headers, profile, release, and configured D1 identities. `bypassQueryParams` optionally lists exact query keys that bypass the lease. `ignoreRequestCacheControl` optionally allows lease hits when the browser sends `no-cache` or `no-store`; it defaults to false. A configured `freshnessHeader` always forces a fresh read when present. Configure every credential and response-varying header. Workers require `nodejs_compat`.

After successful authentication, call `limitD1ReadLeaseUntil` with the credential's absolute expiry in epoch milliseconds. Missing, undefined or expired deadlines prevent a fill. The source receives `Cache-Control: no-cache` on a lease miss. A successful mutation sets an HttpOnly freshness cookie for the configured maximum. In the default `bypass` mode, requests carrying it bypass the lease. Optional `freshnessCookieMode: 'generation'` requires `cookie` in `credentialHeaders`: each mutation creates a new cookie value, and its first read uses fresh data before its response can be reused. Legacy or invalid markers still bypass. A reused regional query value caps the response lease at that value’s original expiry; a fresh source load is not capped by the query-cache TTL. `freshnessCookieExcludedPaths` optionally excludes known non-mutating paths from this cookie using the same whole-segment path matching. Client response headers remain unchanged on reads. Writes always execute the handler. Authorization changes by other actors can take up to the lease duration to take effect on cached reads.

When authentication runs in a separate trusted service binding, wrap that service's handler with `wrapD1ReadLeaseOrigin(handler)` and use `forwardD1ReadLease(request, service)` inside the gateway lease handler. The origin wrapper supplies the request-local deadline scope. The forwarder transfers the verified deadline only over the binding and removes its internal header before returning the response. A gateway must trust the bound service to verify credentials and protect this internal proof.

Browser clients can import `createReadFreshness(policy)` from `@dee-wan/cache/client` using the same `readResponseLease` policy. Call `observe(scope, method, url, transport?)` after a successful response, then merge `headers(scope, method)` into requests. With generation mode, pass the request origin, base URL and `withCredentials: true` to use the cookie for confirmed same-origin writes; other transports keep the fresh-header fallback. Data mutations otherwise enable fresh GET headers for the configured maximum per scope; excluded paths use the same whole-segment rules as the server.

`createMutationInvalidation(policy)` from `@dee-wan/cache/client` signals successful writes between listeners and browser tabs. Call `publish(scope, method, url)` after success and `subscribe(scope, listener)` to receive `{ scope, method, pathname }`; call the returned function to unsubscribe and `dispose()` when finished. The URL's query and credentials are not sent. Use a credential-free scope. Read methods and `freshnessCookieExcludedPaths` are ignored. The channel is opened only when the factory runs in a browser.

`createRevalidationWindow(intervalMs, now?)` coalesces automatic checks per scope. `remaining(scope)` establishes a deadline without moving it on later calls; `take(scope)` permits an uninitialized scope immediately and an initialized scope at or after its deadline. Mutation notifications remain immediate and do not use this window.
