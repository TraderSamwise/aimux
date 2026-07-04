import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const cliBootstrapInventory = [
  { id: "bin-shim", path: "bin/aimux", pattern: /node/ },
  { id: "release-shim", path: "scripts/install.sh", pattern: /AIMUX_NODE_BIN[\s\S]*dist\/launcher-bin\.js/ },
] as const;

const scanRoots = ["bin", "scripts", "src"] as const;
const runtimeBoundaryFiles = ["package.json", "app/package.json"] as const;
const skippedDirectories = new Set([".git", "coverage", "dist", "dist-ui", "node_modules", "release"]);
const skippedFiles = [/\.test\.[cm]?[jt]sx?$/, /\.d\.ts$/];
const skippedDeclarationFiles = [/\.d\.ts$/];
// Keep split so this test file does not match its own retired-entrypoint scan.
const retiredMainSlashPath = "dist/" + "main.js";
const retiredMainPatterns = [
  { id: "slash-path", pattern: new RegExp(retiredMainSlashPath.replace("/", "\\/")) },
  { id: "path-join", pattern: /["'`]dist["'`]\s*,\s*["'`]main\.js["'`]/ },
] as const;

const runtimeNodeLaunchPatterns = [
  { id: "direct-node-launcher", pattern: /\bnode\s+dist\/launcher-bin\.js\b/ },
  { id: "node-eval", pattern: /(?:^|\n)\s*[^#\n]*\bnode\s+-e\b/ },
  { id: "node-heredoc", pattern: /(?:^|\n)\s*node\s+<</ },
  { id: "node-dash-heredoc", pattern: /(?:^|\n)\s*[^#\n]*\bnode\s+-\s*(?:[^\n<]*\s)?<</ },
  { id: "spawn-process-execpath", pattern: /\bspawn(?:Sync)?\(\s*process\.execPath/ },
  { id: "exec-process-execpath", pattern: /\bexecFile(?:Sync)?\(\s*process\.execPath/ },
  { id: "project-restart-cli", pattern: /["'`]restart["'`][\s\S]{0,160}["'`]--project["'`]/ },
  { id: "dev-lane", pattern: /scripts\/dev-lanes|dev:aimux:|dev:daemon:/ },
] as const;

const processInspectionPatterns = [
  { id: "pid-alive-helper", pattern: /function\s+isPidAlive\s*\(/ },
  { id: "ps-args", pattern: /execFileSync\(\s*["'`]ps["'`][\s\S]{0,160}["'`]args=["'`]/ },
  { id: "ps-stat", pattern: /execFileSync\(\s*["'`]ps["'`][\s\S]{0,160}["'`]stat=["'`]/ },
  { id: "ps-table", pattern: /execFileSync\(\s*["'`]ps["'`][\s\S]{0,160}["'`]-axo["'`]/ },
  { id: "lsof-cwd", pattern: /execFileSync\(\s*["'`]lsof["'`][\s\S]{0,180}["'`]cwd["'`]/ },
] as const;

const allowedRuntimePatternMatches = new Set<string>();
const allowedProcessInspectionFiles = new Set(["src/process-inspector.ts"]);
const allowedCommandArgMatchFiles = new Set(["src/process-args.ts", "src/process-inspector.ts"]);
const allowedRetiredMainEntrypoints = [
  { file: "src/dashboard/command-spec.ts", id: "path-join", lineIncludes: 'join(installRoot, "dist", "main.js")' },
  { file: "src/daemon.test.ts", id: "slash-path", lineIncludes: "node /opt/aimux/dist/main.js" },
  { file: "src/project-takeover.test.ts", id: "slash-path", lineIncludes: "node /opt/aimux/dist/main.js" },
  { file: "src/process-inspector.test.ts", id: "slash-path", lineIncludes: "node /opt/aimux/dist/main.js" },
  { file: "src/runtime-coherence.test.ts", id: "slash-path", lineIncludes: "/opt/aimux/native/local-old/dist/main.js" },
  { file: "src/runtime-coherence.ts", id: "slash-path", lineIncludes: '"/dist/main.js"' },
  { file: "src/runtime-restart.test.ts", id: "slash-path", lineIncludes: "/old/dist/main.js" },
  { file: "src/runtime-restart.test.ts", id: "slash-path", lineIncludes: "node /opt/aimux/dist/main.js" },
] as const;

const launchContractUsage = [
  {
    name: "getAimuxDaemonLaunchCommand",
    allowedFiles: new Set(["src/cli-launcher.ts", "src/daemon-supervisor.ts", "src/cli-launcher.test.ts"]),
  },
  {
    name: "getAimuxDashboardLaunchCommand",
    allowedFiles: new Set(["src/cli-launcher.ts", "src/dashboard/command-spec.ts", "src/cli-launcher.test.ts"]),
  },
  {
    name: "getAimuxCurrentCliIdentity",
    allowedFiles: new Set(["src/cli-launcher.ts", "src/runtime-coherence.ts", "src/cli-launcher.test.ts"]),
  },
] as const;

function listSourceFiles(root: string, options: { includeTests?: boolean } = {}): string[] {
  const absoluteRoot = join(process.cwd(), root);
  const files: string[] = [];
  const skipPatterns = options.includeTests ? skippedDeclarationFiles : skippedFiles;
  const visit = (path: string) => {
    const relativePath = relative(process.cwd(), path);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (skippedDirectories.has(relativePath.split("/").at(-1) ?? "")) return;
      for (const child of readdirSync(path)) visit(join(path, child));
      return;
    }
    if (!stat.isFile()) return;
    if (skipPatterns.some((pattern) => pattern.test(relativePath))) return;
    files.push(relativePath);
  };
  visit(absoluteRoot);
  return files;
}

describe("one-shot Node runtime inventory", () => {
  it("keeps public package entrypoints on the bin shim", () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      main?: string;
      bin?: { aimux?: string };
      scripts?: { start?: string };
    };

    expect(packageJson.main).toBe("bin/aimux");
    expect(packageJson.bin?.aimux).toBe("./bin/aimux");
    expect(packageJson.scripts?.start).toBe("./bin/aimux");
  });

  it("keeps the Node CLI bootstrap explicit", () => {
    expect(cliBootstrapInventory).toHaveLength(2);
    for (const entry of cliBootstrapInventory) {
      const text = readFileSync(join(process.cwd(), entry.path), "utf8");
      expect(text, entry.id).toMatch(entry.pattern);
    }
  });

  it("keeps runtime Node launch sites in an explicit allowlist", () => {
    const violations: string[] = [];
    const files = [...scanRoots.flatMap((root) => listSourceFiles(root)), ...runtimeBoundaryFiles];
    for (const file of files) {
      const text = readFileSync(join(process.cwd(), file), "utf8");
      for (const entry of runtimeNodeLaunchPatterns) {
        if (!entry.pattern.test(text)) continue;
        const key = `${file}:${entry.id}`;
        if (!allowedRuntimePatternMatches.has(key)) violations.push(key);
      }
      if (text.includes("getAimuxCliLaunchCommand")) {
        violations.push(`${file}:generic-cli-launch-command`);
      }
      for (const contract of launchContractUsage) {
        if (text.includes(contract.name) && !contract.allowedFiles.has(file)) {
          violations.push(`${file}:${contract.name}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("recognizes node heredoc variants", () => {
    const dashHeredoc = runtimeNodeLaunchPatterns.find((entry) => entry.id === "node-dash-heredoc");

    expect(dashHeredoc?.pattern.test("node - <<'NODE'\n")).toBe(true);
    expect(dashHeredoc?.pattern.test('AIMUX_INPUT="$value" node - "$arg" <<\'NODE\'\n')).toBe(true);
  });

  it("keeps the retired main entrypoint quarantined", () => {
    const violations: string[] = [];
    for (const file of scanRoots.flatMap((root) => listSourceFiles(root, { includeTests: true }))) {
      if (file === "src/one-shot-node-inventory.test.ts") continue;
      const lines = readFileSync(join(process.cwd(), file), "utf8").split("\n");
      lines.forEach((line, index) => {
        for (const entry of retiredMainPatterns) {
          if (!entry.pattern.test(line)) continue;
          const allowed = allowedRetiredMainEntrypoints.some(
            (candidate) =>
              candidate.file === file && candidate.id === entry.id && line.includes(candidate.lineIncludes),
          );
          if (!allowed) violations.push(`${file}:${index + 1}:${entry.id}`);
        }
      });
    }

    expect(violations).toEqual([]);
  });

  it("keeps OS process inspection behind the shared inspector", () => {
    const violations: string[] = [];
    for (const file of scanRoots.flatMap((root) => listSourceFiles(root))) {
      const text = readFileSync(join(process.cwd(), file), "utf8");
      for (const entry of processInspectionPatterns) {
        if (entry.pattern.test(text) && !allowedProcessInspectionFiles.has(file)) {
          violations.push(`${file}:${entry.id}`);
        }
      }
      if (text.includes("commandArgValueMatches") && !allowedCommandArgMatchFiles.has(file)) {
        violations.push(`${file}:commandArgValueMatches`);
      }
    }

    expect(violations).toEqual([]);
  });
});
