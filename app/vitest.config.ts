import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["**/*.test.{ts,tsx}"],
    coverage: {
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "coverage",
      include: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}"],
      exclude: ["**/*.test.{ts,tsx}", "**/*.d.ts", "coverage/**", "scripts/**"],
    },
  },
  resolve: {
    alias: {
      "@/": path.resolve(__dirname, "") + "/",
    },
  },
});
