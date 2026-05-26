import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    globals: true,
    include: ["src/**/*.test.ts", "relay/src/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
