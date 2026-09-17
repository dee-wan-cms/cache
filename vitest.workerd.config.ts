import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    globalSetup: ["test/workerd/global-setup.ts"],
    hookTimeout: 180_000,
    include: ["test/workerd/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
