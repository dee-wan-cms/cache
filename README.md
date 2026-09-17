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
