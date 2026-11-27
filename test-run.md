# Latest full project suite

- Date: 2026-11-27
- Revision: `9261bc5a104ac3c767d3e46b988ba78ecb98a198`
- Relevant working tree: modified `package.json`, `src/cloudflare/index.ts`, `src/d1/json-read.ts`, `src/d1/read.ts`, `src/yandex/read.ts`, `test/tsconfig.d1-unit.json`, `test/tsconfig.node.json`, `tsup.config.ts`; untracked `src/cloudflare/durable-public.ts`, `test/unit/durable-public.test.ts`, `test/unit/read-ttl-policy.test.ts`. Parent revision `75effe12778c950d67d8e594e326d8c6b1e45fee` has modified root `package.json` and `package-lock.json`; dependencies use the existing workspace installation.
- Config: `vitest.unit.config.ts`, `vitest.workerd.config.ts`, `vitest.consumer.config.ts`; Node 24.18.1; Vitest 3.2.7.
- Unit: PASS, 32 files, 457 tests.
- Workerd: PASS, 9 files, 87 tests.
- Packed consumer: PASS, 1 file, 1 test.
- Total: PASS, 42 files, 545 tests; zero skipped.
- Commands run from the repository root.

```sh
taskpolicy -b nice -n 19 env PATH=/Users/danilt/.nvm/versions/node/v24.18.1/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin WRANGLER_SEND_METRICS=false WRANGLER_SEND_ERROR_REPORTS=false NODE_OPTIONS=--max-old-space-size=2048 UV_THREADPOOL_SIZE=1 RAYON_NUM_THREADS=1 npm --workspace @dee-wan/cache run test:unit -- --maxWorkers=1 --no-file-parallelism --maxConcurrency=1
taskpolicy -b nice -n 19 env PATH=/Users/danilt/.nvm/versions/node/v24.18.1/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin WRANGLER_SEND_METRICS=false WRANGLER_SEND_ERROR_REPORTS=false NODE_OPTIONS=--max-old-space-size=2048 UV_THREADPOOL_SIZE=1 RAYON_NUM_THREADS=1 npm --workspace @dee-wan/cache run test:workerd -- --maxWorkers=1 --no-file-parallelism --maxConcurrency=1
taskpolicy -b nice -n 19 env PATH=/Users/danilt/.nvm/versions/node/v24.18.1/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin WRANGLER_SEND_METRICS=false WRANGLER_SEND_ERROR_REPORTS=false NODE_OPTIONS=--max-old-space-size=2048 UV_THREADPOOL_SIZE=1 RAYON_NUM_THREADS=1 npm --workspace @dee-wan/cache run test:consumer -- --maxWorkers=1 --no-file-parallelism --maxConcurrency=1
```
