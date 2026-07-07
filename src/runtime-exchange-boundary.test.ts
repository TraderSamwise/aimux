import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const skippedDirectories = new Set([".git", "coverage", "dist", "dist-ui", "node_modules", "release"]);
const skippedFiles = [/\.d\.ts$/];

const allowedLegacyExchangeFiles = new Set([
  "src/paths.ts",
  "src/runtime-migration.ts",
  "src/runtime-migration.test.ts",
  "src/runtime-core/exchange-import.ts",
  "src/runtime-core/exchange-import.test.ts",
  "src/runtime-exchange-boundary.test.ts",
  "src/tasks.test.ts",
]);

const allowedPlanAuthorityFiles = new Set([
  "src/paths.ts",
  "src/runtime-core/plan-authority.ts",
  "src/runtime-core/exchange-import.ts",
  "src/runtime-core/exchange-import.test.ts",
  "src/runtime-exchange-boundary.test.ts",
  "src/builtin-metadata-watchers.ts",
  "src/builtin-metadata-watchers.test.ts",
  "src/graveyard-cleanup.ts",
  "src/graveyard-cleanup.test.ts",
  "src/metadata-server.test.ts",
  "src/multiplexer/persistence-methods.test.ts",
  "src/runtime-core/exchange-store.test.ts",
]);

const legacyExchangePathPatterns = [
  /\bgetLegacy(?:Threads|Tasks)Dir\b/,
  /join\([^)]*(?:getLocalAimuxDir\(\)|localAimuxDir|repoRoot)[^)]*,\s*["'](?:threads|tasks)["']/,
  /join\([^)]*["']\.aimux["'][^)]*,\s*["'](?:threads|tasks)["']/,
  /\.aimux\/(?:threads|tasks)\b/,
];

const planAuthorityPathPatterns = [/\bgetPlansDir\b/];

function listSourceFiles(root: string): string[] {
  const absoluteRoot = join(process.cwd(), root);
  const files: string[] = [];
  const visit = (path: string) => {
    const relativePath = relative(process.cwd(), path);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (skippedDirectories.has(relativePath.split("/").at(-1) ?? "")) return;
      for (const child of readdirSync(path)) visit(join(path, child));
      return;
    }
    if (!stat.isFile() || skippedFiles.some((pattern) => pattern.test(relativePath))) return;
    if (!/\.[cm]?[jt]sx?$/.test(relativePath)) return;
    files.push(relativePath);
  };
  visit(absoluteRoot);
  return files;
}

describe("runtime exchange boundary", () => {
  it("keeps legacy thread/task directories quarantined to explicit import tooling", () => {
    const violations: string[] = [];
    for (const file of ["src", "app"].flatMap((root) => listSourceFiles(root))) {
      const text = readFileSync(join(process.cwd(), file), "utf8");
      if (!legacyExchangePathPatterns.some((pattern) => pattern.test(text))) continue;
      if (!allowedLegacyExchangeFiles.has(file)) violations.push(file);
    }

    expect(violations).toEqual([]);
  });

  it("keeps generic legacy exchange dir helpers deleted", () => {
    const pathsSource = readFileSync(join(process.cwd(), "src", "paths.ts"), "utf8");

    expect(pathsSource).not.toContain("function getThreadsDir");
    expect(pathsSource).not.toContain("function getTasksDir");
  });

  it("keeps exchange alert recipient routing out of the metadata server", () => {
    const metadataServerSource = readFileSync(join(process.cwd(), "src", "metadata-server.ts"), "utf8");

    expect(metadataServerSource).not.toContain("resolveAlertRecipients");
    expect(metadataServerSource).not.toContain("payload?.deliveredTo");
  });

  it("keeps plan markdown authority behind explicit plan-authority APIs", () => {
    const violations: string[] = [];
    for (const file of ["src", "app"].flatMap((root) => listSourceFiles(root))) {
      const text = readFileSync(join(process.cwd(), file), "utf8");
      if (!planAuthorityPathPatterns.some((pattern) => pattern.test(text))) continue;
      if (!allowedPlanAuthorityFiles.has(file)) violations.push(file);
    }

    expect(violations).toEqual([]);
  });
});
