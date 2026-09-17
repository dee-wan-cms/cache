import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    include: ["test/deployed/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
