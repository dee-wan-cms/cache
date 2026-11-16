# Latest full project suite

- Date: 2026-11-16
- Revision: `1bfa6e3752e892cc9e99b9b5ecaca69f07ce6be6`
- Working tree: modified `src/cloudflare/{coordinator-core,regional-store,store}.ts`, `src/core/{extension,types}.ts`, `src/d1/{env,read,regional-response,session}.ts`, `src/{index,scoped-read}.ts`, `src/yandex/{prisma,read,store,versioned-store}.ts`; new `src/core/{local-fill,wait}.ts`. Modified tests: `test/unit/{coordinator-core,d1-regional,d1-write-deadline,extension,regional-response,scoped-read}.test.ts`, `test/workerd/{correctness,d1-read,d1-session}.test.ts`, `test/workerd/rig.ts`, `test/workerd/worker/app.ts`; new `test/unit/{local-notification,yandex-read}.test.ts`. Dependencies and test configs unchanged.
- Config: `vitest.unit.config.ts`, `vitest.workerd.config.ts`, `vitest.consumer.config.ts`; Node 24.18.1; Vitest 3.2.7.
- Unit: PASS, 30 files, 399 tests.
- Workerd: PASS, 9 files, 86 tests.
- Packed consumer: PASS, 1 file, 1 test.
- Total: PASS, 40 files, 486 tests.

```sh
taskpolicy -b nice -n 19 env PATH="/Users/danilt/.nvm/versions/node/v24.18.1/bin:$PATH" NODE_OPTIONS=--max-old-space-size=2048 UV_THREADPOOL_SIZE=1 RAYON_NUM_THREADS=1 /Users/danilt/.nvm/versions/node/v24.18.1/bin/node ../../node_modules/vitest/vitest.mjs run --config vitest.unit.config.ts --maxWorkers=1 --no-file-parallelism --maxConcurrency=1
taskpolicy -b nice -n 19 env PATH="/Users/danilt/.nvm/versions/node/v24.18.1/bin:$PATH" NODE_OPTIONS=--max-old-space-size=2048 UV_THREADPOOL_SIZE=1 RAYON_NUM_THREADS=1 /Users/danilt/.nvm/versions/node/v24.18.1/bin/node ../../node_modules/vitest/vitest.mjs run --config vitest.workerd.config.ts --maxWorkers=1 --no-file-parallelism --maxConcurrency=1
taskpolicy -b nice -n 19 env PATH="/Users/danilt/.nvm/versions/node/v24.18.1/bin:$PATH" NODE_OPTIONS=--max-old-space-size=2048 UV_THREADPOOL_SIZE=1 RAYON_NUM_THREADS=1 /Users/danilt/.nvm/versions/node/v24.18.1/bin/node ../../node_modules/vitest/vitest.mjs run --config vitest.consumer.config.ts --maxWorkers=1 --no-file-parallelism --maxConcurrency=1
```
