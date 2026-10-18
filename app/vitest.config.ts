import { configDefaults, defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["**/*.test.{ts,tsx}"],
          exclude: [...configDefaults.exclude, "**/*.component.test.tsx"],
        },
      },
      {
        extends: true,
        resolve: {
          alias: [{ find: /^react-native$/, replacement: "react-native-web" }],
          dedupe: ["react", "react-dom"],
        },
        test: {
          name: "components",
          environment: "jsdom",
          include: ["**/*.component.test.tsx"],
          setupFiles: ["./test/setup-components.ts"],
        },
      },
    ],
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
