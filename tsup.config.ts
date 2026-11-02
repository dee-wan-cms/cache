import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { "scoped-read": "src/scoped-read.ts", index: "src/index.ts", client: "src/client.ts", "cloudflare/index": "src/cloudflare/index.ts", "d1/index": "src/d1/index.ts", "d1/config": "src/d1/config.ts", "d1/response-lease": "src/d1/read-response-lease.ts", "response-lease": "src/http-response-lease.ts" },
    format: ["esm"],
    platform: "neutral",
    removeNodeProtocol: false,
    target: "es2022",
    dts: true,
    sourcemap: true,
    splitting: true,
    treeshake: true,
    external: ["cloudflare:workers", "node:async_hooks"],
  },
  {
    entry: { "generator/index": "src/generator/index.ts", "generator/config": "src/generator/config.ts" },
    format: ["esm"],
    platform: "node",
    target: "node20",
    dts: true,
    sourcemap: true,
    splitting: false,
    external: ["@prisma/generator-helper"],
  },
]);
