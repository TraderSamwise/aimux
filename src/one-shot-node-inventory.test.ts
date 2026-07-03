import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const cliBootstrapInventory = [
  { id: "bin-shim", path: "bin/aimux", pattern: /node/ },
  { id: "release-shim", path: "scripts/install.sh", pattern: /AIMUX_NODE_BIN[\s\S]*dist\/main\.js/ },
] as const;

const scanRoots = ["bin", "scripts", "src"] as const;
const skippedDirectories = new Set([".git", "coverage", "dist", "dist-ui", "node_modules", "release"]);
const skippedFiles = [/\.test\.[cm]?[jt]sx?$/, /\.d\.ts$/];

const runtimeNodeLaunchPatterns = [
  { id: "node-heredoc", pattern: /(?:^|\n)\s*node\s+<</ },
  { id: "node-dash-heredoc", pattern: /(?:^|\n)\s*node\s+-\s*<</ },
  { id: "spawn-process-execpath", pattern: /\bspawn(?:Sync)?\(\s*process\.execPath/ },
  { id: "exec-process-execpath", pattern: /\bexecFile(?:Sync)?\(\s*process\.execPath/ },
  { id: "project-restart-cli", pattern: /"restart",\s*"--project"/ },
] as const;

const allowedRuntimePatternMatches = new Set(["scripts/build-local-ui.sh:node-heredoc"]);

const allowedCliLaunchCommandUsage = new Set([
  "src/cli-launcher.ts",
  "src/daemon.ts",
  "src/dashboard/command-spec.ts",
  "src/runtime-coherence.ts",
]);

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
    if (!stat.isFile()) return;
    if (skippedFiles.some((pattern) => pattern.test(relativePath))) return;
    files.push(relativePath);
  };
  visit(absoluteRoot);
  return files;
}

describe("one-shot Node runtime inventory", () => {
  it("keeps the Node CLI bootstrap explicit", () => {
    expect(cliBootstrapInventory).toHaveLength(2);
    for (const entry of cliBootstrapInventory) {
      const text = readFileSync(join(process.cwd(), entry.path), "utf8");
      expect(text, entry.id).toMatch(entry.pattern);
    }
  });

  it("keeps runtime Node launch sites in an explicit allowlist", () => {
    const violations: string[] = [];
    for (const file of scanRoots.flatMap((root) => listSourceFiles(root))) {
      const text = readFileSync(join(process.cwd(), file), "utf8");
      for (const entry of runtimeNodeLaunchPatterns) {
        if (!entry.pattern.test(text)) continue;
        const key = `${file}:${entry.id}`;
        if (!allowedRuntimePatternMatches.has(key)) violations.push(key);
      }
      if (text.includes("getAimuxCliLaunchCommand") && !allowedCliLaunchCommandUsage.has(file)) {
        violations.push(`${file}:getAimuxCliLaunchCommand`);
      }
    }

    expect(violations).toEqual([]);
  });
});
