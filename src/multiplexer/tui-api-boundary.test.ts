import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoots = ["src/multiplexer", "src/dashboard", "src/tui"];

const allowedTransportFiles = new Set(["src/multiplexer/dashboard-control.ts", "src/multiplexer/tui-api-runtime.ts"]);

const forbiddenTransportPatterns: Array<{ label: string; pattern: RegExp }> = [
  {
    label: "raw host project-service transport",
    pattern: /\bhost\.(getFromProjectService|postToProjectService)\s*\(/g,
  },
  {
    label: "raw instance project-service transport",
    pattern: /\bthis\.(getFromProjectService|postToProjectService)\s*\(/g,
  },
  {
    label: "low-level project-service request loop",
    pattern: /\brequestProjectService\s*\(/g,
  },
];

function walkTypescriptFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walkTypescriptFiles(path);
    if (!path.endsWith(".ts") || path.endsWith(".test.ts") || path.endsWith(".d.ts")) return [];
    return [path];
  });
}

function lineForIndex(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

describe("TUI API boundary", () => {
  it("keeps production TUI code behind the shared API runtime", () => {
    const violations: string[] = [];

    for (const root of sourceRoots) {
      for (const file of walkTypescriptFiles(join(process.cwd(), root))) {
        const rel = relative(process.cwd(), file);
        if (allowedTransportFiles.has(rel)) continue;
        const source = readFileSync(file, "utf8");

        for (const { label, pattern } of forbiddenTransportPatterns) {
          pattern.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = pattern.exec(source))) {
            violations.push(`${rel}:${lineForIndex(source, match.index)} ${label}: ${match[0]}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
