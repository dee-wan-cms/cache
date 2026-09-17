import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});
