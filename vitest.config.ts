import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    globals: true,
    include: ["relay/src/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
