import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    hookTimeout: 900_000,
    include: ["test/consumer/**/*.test.ts"],
    testTimeout: 300_000,
  },
});
