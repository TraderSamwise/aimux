#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/source-boundary/inventory.json", ROOT);
const rootPath = ROOT.pathname.replace(/\/$/, "");

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function source(path) {
  return readFileSync(join(rootPath, path), "utf8");
}

function listFiles(root, options = {}) {
  const skippedDirectories = new Set([".git", "coverage", "dist", "dist-ui", "node_modules", "release"]);
  const files = [];
  const visit = (path) => {
    const rel = relative(rootPath, path);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (skippedDirectories.has(rel.split("/").at(-1) ?? "")) return;
      for (const child of readdirSync(path)) visit(join(path, child));
      return;
    }
    if (!stat.isFile()) return;
    if (options.tsOnly && !path.endsWith(".ts")) return;
    if (options.skipTests && /\.test\.[cm]?[jt]sx?$/.test(rel)) return;
    if (/\.d\.ts$/.test(rel)) return;
    if (/^scripts\/capture-.*-contract(?:s)?\.mjs$/.test(rel)) return;
    files.push(rel);
  };
  visit(join(rootPath, root));
  return files.sort();
}

function childProcessImport(text) {
  return /(?:from\s+["'](?:node:)?child_process["']|import\(\s*["'`](?:node:)?child_process["'`]\s*\)|require\(\s*["'`](?:node:)?child_process["'`]\s*\))/.test(
    text,
  );
}

function lineForIndex(text, index) {
  return text.slice(0, index).split("\n").length;
}

function caseFor({ id, name, source: testSource, input, output }) {
  return {
    id,
    name,
    source: testSource,
    input,
    output,
    inputSha256: hash(input),
  };
}

const cases = [];

{
  const daemonSource = source("src/daemon.ts");
  const forbidden = [
    'from "./daemon-supervisor.js"',
    "export async function ensureDaemonRunning",
    "export async function stopDaemon",
    "export async function requestDaemonJson",
    "export async function ensureProjectService",
    "export async function stopProjectService",
    "export async function projectServiceStatus",
  ];
  cases.push(
    caseFor({
      id: "core-sidecar-001",
      name: "keeps daemon implementation separate from supervisor bootstrap helpers",
      source: "src/core-sidecar-boundary.test.ts",
      input: { api: "forbiddenSubstrings", file: "src/daemon.ts", forbidden },
      output: forbidden.filter((pattern) => daemonSource.includes(pattern)),
    }),
  );
}

{
  const checks = [
    { file: "src/daemon-supervisor.ts", forbidden: ["export async function requestDaemonJson"] },
    { file: "src/daemon-client.ts", required: ["export async function requestDaemonJson"] },
  ];
  cases.push(
    caseFor({
      id: "core-sidecar-002",
      name: "keeps daemon HTTP transport separate from supervisor bootstrap",
      source: "src/core-sidecar-boundary.test.ts",
      input: { api: "substringPolicy", checks },
      output: checks.flatMap((check) => {
        const text = source(check.file);
        return [
          ...(check.forbidden ?? []).filter((pattern) => text.includes(pattern)).map((pattern) => `${check.file}:forbidden:${pattern}`),
          ...(check.required ?? []).filter((pattern) => !text.includes(pattern)).map((pattern) => `${check.file}:missing:${pattern}`),
        ];
      }),
    }),
  );
}

{
  const checks = [
    { file: "src/core-command-transport.ts", forbidden: ["daemon-supervisor.js"] },
    { file: "src/core-command-client.ts", required: ["ensureDaemonRunning", "sendCoreCommand"], forbidden: ["CORE_API_ROUTES", "requestDaemonJson"] },
  ];
  cases.push(
    caseFor({
      id: "core-sidecar-003",
      name: "keeps core command HTTP transport separate from lifecycle startup",
      source: "src/core-sidecar-boundary.test.ts",
      input: { api: "substringPolicy", checks },
      output: checks.flatMap((check) => {
        const text = source(check.file);
        return [
          ...(check.forbidden ?? []).filter((pattern) => text.includes(pattern)).map((pattern) => `${check.file}:forbidden:${pattern}`),
          ...(check.required ?? []).filter((pattern) => !text.includes(pattern)).map((pattern) => `${check.file}:missing:${pattern}`),
        ];
      }),
    }),
  );
}

{
  const forbidden = ["./main.js", "./multiplexer/", "./tmux/", "./dashboard/", "./local-ui-server.js"];
  const text = source("src/core-cli.ts");
  cases.push(
    caseFor({
      id: "core-sidecar-004",
      name: "keeps the routed core CLI out of the full runtime and TUI graph",
      source: "src/core-sidecar-boundary.test.ts",
      input: { api: "forbiddenSubstrings", file: "src/core-cli.ts", forbidden },
      output: forbidden.filter((pattern) => text.includes(pattern)),
    }),
  );
}

{
  const allowed = new Set([
    "cli/project-service.ts",
    "control-plane-restart-client.ts",
    "core-command-client.ts",
    "daemon-supervisor.ts",
    "main.ts",
    "runtime-restart.ts",
  ]);
  const offenders = listFiles("src", { tsOnly: true, skipTests: true })
    .map((file) => file.replace(/^src\//, ""))
    .filter((file) => !allowed.has(file))
    .filter((file) => source(`src/${file}`).includes("daemon-supervisor.js"));
  cases.push(
    caseFor({
      id: "core-sidecar-005",
      name: "keeps ordinary clients out of daemon supervisor lifecycle code",
      source: "src/core-sidecar-boundary.test.ts",
      input: { api: "daemonSupervisorImportInventory", allowed: [...allowed].sort() },
      output: offenders,
    }),
  );
}

{
  const offenders = listFiles("src/multiplexer", { tsOnly: true, skipTests: true }).filter((file) =>
    source(file).includes("core-command-client.js"),
  );
  cases.push(
    caseFor({
      id: "core-sidecar-006",
      name: "keeps multiplexer clients out of daemon-starting core command wrappers",
      source: "src/core-sidecar-boundary.test.ts",
      input: { api: "multiplexerCoreCommandClientImports" },
      output: offenders,
    }),
  );
}

{
  const allowed = new Set([
    "src/multiplexer/dashboard-interaction.ts",
    "src/multiplexer/persistence-methods.ts",
    "src/multiplexer/tui-visibility.ts",
  ]);
  const offenders = listFiles("src/multiplexer", { tsOnly: true, skipTests: true })
    .filter((file) => !allowed.has(file))
    .filter((file) => childProcessImport(source(file)));
  cases.push(
    caseFor({
      id: "core-sidecar-007",
      name: "keeps routine multiplexer client screens out of child process launches",
      source: "src/core-sidecar-boundary.test.ts",
      input: { api: "multiplexerChildProcessImports", allowed: [...allowed].sort() },
      output: offenders,
    }),
  );
}

{
  const allowedLegacyExchangeFiles = new Set([
    "src/paths.ts",
    "src/runtime-migration.ts",
    "src/runtime-migration.test.ts",
    "src/runtime-core/exchange-import.ts",
    "src/runtime-core/exchange-import.test.ts",
    "src/runtime-exchange-boundary.test.ts",
    "src/tasks.test.ts",
  ]);
  const legacyExchangePathPatterns = [
    /\bgetLegacy(?:Threads|Tasks)Dir\b/,
    /join\([^)]*(?:getLocalAimuxDir\(\)|localAimuxDir|repoRoot)[^)]*,\s*["'](?:threads|tasks)["']/,
    /join\([^)]*["']\.aimux["'][^)]*,\s*["'](?:threads|tasks)["']/,
    /\.aimux\/(?:threads|tasks)\b/,
  ];
  const violations = ["src", "app"]
    .flatMap((root) => listFiles(root))
    .filter((file) => legacyExchangePathPatterns.some((pattern) => pattern.test(source(file))))
    .filter((file) => !allowedLegacyExchangeFiles.has(file));
  cases.push(
    caseFor({
      id: "runtime-exchange-boundary-001",
      name: "keeps legacy thread/task directories quarantined to explicit import tooling",
      source: "src/runtime-exchange-boundary.test.ts",
      input: { api: "legacyExchangePathInventory", allowed: [...allowedLegacyExchangeFiles].sort() },
      output: violations,
    }),
  );
}

{
  const pathsSource = source("src/paths.ts");
  const forbidden = ["function getThreadsDir", "function getTasksDir"];
  cases.push(
    caseFor({
      id: "runtime-exchange-boundary-002",
      name: "keeps generic legacy exchange dir helpers deleted",
      source: "src/runtime-exchange-boundary.test.ts",
      input: { api: "forbiddenSubstrings", file: "src/paths.ts", forbidden },
      output: forbidden.filter((pattern) => pathsSource.includes(pattern)),
    }),
  );
}

{
  const metadataServerSource = source("src/metadata-server.ts");
  const forbidden = ["resolveAlertRecipients", "payload?.deliveredTo"];
  cases.push(
    caseFor({
      id: "runtime-exchange-boundary-003",
      name: "keeps exchange alert recipient routing out of the metadata server",
      source: "src/runtime-exchange-boundary.test.ts",
      input: { api: "forbiddenSubstrings", file: "src/metadata-server.ts", forbidden },
      output: forbidden.filter((pattern) => metadataServerSource.includes(pattern)),
    }),
  );
}

{
  const allowedPlanAuthorityFiles = new Set([
    "src/paths.ts",
    "src/runtime-core/plan-authority.ts",
    "src/runtime-core/exchange-import.ts",
    "src/runtime-core/exchange-import.test.ts",
    "src/runtime-exchange-boundary.test.ts",
    "src/builtin-metadata-watchers.test.ts",
    "src/graveyard-cleanup.ts",
    "src/graveyard-cleanup.test.ts",
    "src/metadata-server.test.ts",
    "src/multiplexer/persistence-methods.test.ts",
    "src/runtime-core/exchange-store.test.ts",
  ]);
  const planAuthorityPathPatterns = [
    /\bgetPlansDir\b/,
    /join\([^)]*(?:getLocalAimuxDir\(\)|localAimuxDir|repoRoot)[^)]*,\s*["']plans["']/,
    /join\([^)]*["']\.aimux["'][^)]*,\s*["']plans["']/,
  ];
  const violations = ["src", "app"]
    .flatMap((root) => listFiles(root))
    .filter((file) => planAuthorityPathPatterns.some((pattern) => pattern.test(source(file))))
    .filter((file) => !allowedPlanAuthorityFiles.has(file));
  cases.push(
    caseFor({
      id: "runtime-exchange-boundary-004",
      name: "keeps plan markdown authority behind explicit plan-authority APIs",
      source: "src/runtime-exchange-boundary.test.ts",
      input: { api: "planAuthorityPathInventory", allowed: [...allowedPlanAuthorityFiles].sort() },
      output: violations,
    }),
  );
}

{
  const sourceRoots = ["src/multiplexer", "src/dashboard", "src/tui"];
  const allowedTransportFiles = new Set([
    "src/multiplexer/dashboard-actions-methods.ts",
    "src/multiplexer/dashboard-api-client.ts",
    "src/multiplexer/dashboard-control.ts",
    "src/multiplexer/tui-api-runtime.ts",
  ]);
  const forbiddenTransportPatterns = [
    { label: "raw host project-service transport", pattern: /\bhost\.(getFromProjectService|postToProjectService)\s*\(/g },
    { label: "raw instance project-service transport", pattern: /\bthis\.(getFromProjectService|postToProjectService)\s*\(/g },
    { label: "low-level project-service request loop", pattern: /\brequestProjectService\s*\(/g },
    {
      label: "raw dashboard-control transport import",
      pattern:
        /import\s*{[^}]*\b(getFromProjectService|postToProjectService|requestProjectService)\b[^}]*}\s*from\s*["'][^"']*dashboard-control\.js["']/gs,
    },
  ];
  const violations = [];
  for (const root of sourceRoots) {
    for (const file of listFiles(root, { tsOnly: true, skipTests: true })) {
      if (allowedTransportFiles.has(file)) continue;
      const text = source(file);
      for (const { label, pattern } of forbiddenTransportPatterns) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text))) {
          violations.push(`${file}:${lineForIndex(text, match.index)} ${label}: ${match[0]}`);
        }
      }
    }
  }
  cases.push(
    caseFor({
      id: "tui-api-boundary-001",
      name: "keeps production TUI code behind the shared API runtime",
      source: "src/multiplexer/tui-api-boundary.test.ts",
      input: { api: "tuiApiBoundaryInventory", allowed: [...allowedTransportFiles].sort() },
      output: violations,
    }),
  );
}

{
  const builderFiles = [
    "src/tui/screens/overlay-renderers.ts",
    "src/tui/screens/subscreen-renderers.ts",
    "src/multiplexer/tool-picker.ts",
    "src/multiplexer/dashboard-control.ts",
    "src/multiplexer/subscreens.ts",
    "src/multiplexer/worktrees.ts",
    "src/multiplexer/navigation.ts",
    "src/multiplexer/dashboard-view-methods.ts",
  ];
  for (const file of builderFiles) {
    const text = source(file);
    cases.push(
      caseFor({
        id: `overlay-viewport-${String(cases.filter((entry) => entry.source === "src/tui/render/overlay-viewport-contract.test.ts").length + 1).padStart(3, "0")}`,
        name: `${file} does not read process.stdout dimensions`,
        source: "src/tui/render/overlay-viewport-contract.test.ts",
        input: { api: "stdoutDimensions", file },
        output: {
          readsStdoutDimensions:
            text.includes("process.stdout.columns") ||
            text.includes("process.stdout.rows") ||
            text.includes("process.stdout?.columns") ||
            text.includes("process.stdout?.rows"),
        },
      }),
    );
  }
}

{
  const packageJson = JSON.parse(source("package.json"));
  cases.push(
    caseFor({
      id: "one-shot-node-inventory-001",
      name: "keeps public package entrypoints on the bin shim",
      source: "src/one-shot-node-inventory.test.ts",
      input: { api: "packageEntrypoints" },
      output: {
        main: packageJson.main,
        binAimux: packageJson.bin?.aimux,
        start: packageJson.scripts?.start,
      },
    }),
  );
}

{
  const localNodeToolPattern = /\bnode\s+(?:[.][/])?scripts[/]/;
  const packageFiles = ["package.json", "app/package.json"];
  const scriptViolations = packageFiles.flatMap((file) => {
    const packageJson = JSON.parse(source(file));
    return Object.entries(packageJson.scripts ?? {})
      .filter(([, script]) => localNodeToolPattern.test(script))
      .map(([name]) => `${file}:scripts.${name}`);
  });
  const configFiles = ["app/eas-release.config.json"];
  const configViolations = configFiles.flatMap((file) => (localNodeToolPattern.test(source(file)) ? [`${file}:commands`] : []));
  const fixtureViolations = ["scripts/audit-agent-output-parser.mjs", "app/scripts/check-release-env.js"].filter((file) =>
    localNodeToolPattern.test(source(file)),
  );
  cases.push(
    caseFor({
      id: "one-shot-node-inventory-002",
      name: "keeps command configs from invoking local Node tools through node",
      source: "src/one-shot-node-inventory.test.ts",
      input: { api: "localNodeToolInventory" },
      output: { probes: ["node scripts/tool.js", "node ./scripts/tool.js"].map((text) => localNodeToolPattern.test(text)), violations: [...scriptViolations, ...configViolations, ...fixtureViolations] },
    }),
  );
}

{
  const retiredCliBootstrapInventory = [
    { id: "bin-shim", path: "bin/aimux", pattern: /\bnode\b/ },
    { id: "release-shim", path: "scripts/install.sh", pattern: /installed-aimux-shim\.sh|AIMUX_NODE_BIN/ },
    { id: "installed-shim", path: "scripts/installed-aimux-shim.sh", pattern: /dist\/launcher-bin\.js/ },
  ];
  cases.push(
    caseFor({
      id: "one-shot-node-inventory-003",
      name: "keeps retired Node CLI bootstraps out of the active runtime",
      source: "src/one-shot-node-inventory.test.ts",
      input: { api: "retiredCliBootstrapInventory", entries: retiredCliBootstrapInventory.map(({ id, path }) => ({ id, path })) },
      output: retiredCliBootstrapInventory.filter((entry) => entry.pattern.test(source(entry.path))).map((entry) => entry.id),
    }),
  );
}

{
  const files = [...["bin", "scripts", "src"].flatMap((root) => listFiles(root, { skipTests: true })), "package.json", "app/package.json"];
  const runtimeNodeLaunchPatterns = [
    { id: "direct-node-launcher", pattern: /\bnode\s+dist\/launcher-bin\.js\b/ },
    { id: "node-eval", pattern: /(?:^|\n)\s*[^#\n]*\bnode\s+-e\b/ },
    { id: "node-heredoc", pattern: /(?:^|\n)\s*node\s+<</ },
    { id: "node-dash-heredoc", pattern: /(?:^|\n)\s*[^#\n]*\bnode\s+-\s*(?:[^\n<]*\s)?<</ },
    { id: "node-child-process-file-command", pattern: /\b(?:execFile|execFileSync|spawn|spawnSync)\(\s*["'`]node["'`]/ },
    { id: "node-child-process-shell-command", pattern: /\b(?:exec|execSync)\(\s*["'`]node\b/ },
    { id: "node-child-process-fork-command", pattern: /\b(?:[A-Za-z_$][\w$]*\.)?fork\(/ },
    { id: "spawn-process-execpath", pattern: /\bspawn(?:Sync)?\(\s*process\.execPath/ },
    { id: "exec-process-execpath", pattern: /\bexecFile(?:Sync)?\(\s*process\.execPath/ },
    { id: "project-restart-cli", pattern: /["'`]restart["'`][\s\S]{0,160}["'`]--project["'`]/ },
    { id: "dev-lane", pattern: /scripts\/dev-lanes|dev:aimux:|dev:daemon:/ },
  ];
  const allowedRuntimePatternMatches = new Set();
  const allowedProcessExecPathFiles = new Set(["src/cli-launcher.ts"]);
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
      name: "getAimuxProjectServiceLaunchCommand",
      allowedFiles: new Set(["src/cli-launcher.ts", "src/core-project-actor.ts", "src/cli-launcher.test.ts"]),
    },
    {
      name: "getAimuxCurrentCliIdentity",
      allowedFiles: new Set(["src/cli-launcher.ts", "src/runtime-coherence.ts", "src/cli-launcher.test.ts"]),
    },
  ];
  const violations = [];
  for (const file of files) {
    const text = source(file);
    for (const entry of runtimeNodeLaunchPatterns) {
      if (!entry.pattern.test(text)) continue;
      const key = `${file}:${entry.id}`;
      if (!allowedRuntimePatternMatches.has(key)) violations.push(key);
    }
    if (text.includes("getAimuxCliLaunchCommand")) violations.push(`${file}:generic-cli-launch-command`);
    if (text.includes("process.execPath") && !allowedProcessExecPathFiles.has(file)) violations.push(`${file}:process.execPath`);
    for (const contract of launchContractUsage) {
      if (text.includes(contract.name) && !contract.allowedFiles.has(file)) violations.push(`${file}:${contract.name}`);
    }
  }
  cases.push(
    caseFor({
      id: "one-shot-node-inventory-004",
      name: "keeps runtime Node launch sites in an explicit allowlist",
      source: "src/one-shot-node-inventory.test.ts",
      input: { api: "runtimeNodeLaunchInventory" },
      output: violations,
    }),
  );
}

{
  const allowedChildProcessFiles = new Set([
    "scripts/audit-fixture-enforcement.mjs",
    "scripts/captest.mjs",
    "scripts/hosted-check.mjs",
    "src/context/compactor.ts",
    "src/core-project-actor.ts",
    "src/daemon-supervisor.ts",
    "src/default-plugins/gh-pr-context.ts",
    "src/desktop-notifier.ts",
    "src/full/login-flow.ts",
    "src/lifecycle-orphans.ts",
    "src/local-ui-server.ts",
    "src/login-flow.ts",
    "src/multiplexer/dashboard-interaction.ts",
    "src/multiplexer/persistence-methods.ts",
    "src/multiplexer/tui-visibility.ts",
    "src/paths.ts",
    "src/process-inspector.ts",
    "src/tmux/doctor.ts",
    "src/tmux/expose.ts",
    "src/tmux/runtime-manager.ts",
    "src/worktree.ts",
  ]);
  const violations = ["bin", "scripts", "src"]
    .flatMap((root) => listFiles(root, { skipTests: true }))
    .filter((file) => childProcessImport(source(file)))
    .filter((file) => !allowedChildProcessFiles.has(file));
  cases.push(
    caseFor({
      id: "one-shot-node-inventory-005",
      name: "keeps child process launch sites explicit",
      source: "src/one-shot-node-inventory.test.ts",
      input: { api: "childProcessImportInventory", allowed: [...allowedChildProcessFiles].sort() },
      output: violations,
    }),
  );
}

{
  const pattern = /(?:^|\n)\s*[^#\n]*\bnode\s+-\s*(?:[^\n<]*\s)?<</;
  cases.push(
    caseFor({
      id: "one-shot-node-inventory-006",
      name: "recognizes node heredoc variants",
      source: "src/one-shot-node-inventory.test.ts",
      input: { api: "nodeDashHeredocProbes", probes: ["node - <<'NODE'\n", "AIMUX_INPUT=\"$value\" node - \"$arg\" <<'NODE'\n"] },
      output: ["node - <<'NODE'\n", "AIMUX_INPUT=\"$value\" node - \"$arg\" <<'NODE'\n"].map((probe) => pattern.test(probe)),
    }),
  );
}

{
  const probes = {
    fileCommand: ['spawn("node", ["script.js"])', 'execFileSync("node", ["script.js"])'],
    shellCommand: ['execSync("node scripts/tool.js")'],
    forkCommand: ['fork("scripts/tool.js")', "fork(scriptPath)", "cp.fork(join(root, 'script.js'))"],
  };
  cases.push(
    caseFor({
      id: "one-shot-node-inventory-007",
      name: "recognizes child-process node command variants",
      source: "src/one-shot-node-inventory.test.ts",
      input: { api: "childProcessNodeCommandProbes", probes },
      output: {
        fileCommand: probes.fileCommand.map((probe) => /\b(?:execFile|execFileSync|spawn|spawnSync)\(\s*["'`]node["'`]/.test(probe)),
        shellCommand: probes.shellCommand.map((probe) => /\b(?:exec|execSync)\(\s*["'`]node\b/.test(probe)),
        forkCommand: probes.forkCommand.map((probe) => /\b(?:[A-Za-z_$][\w$]*\.)?fork\(/.test(probe)),
      },
    }),
  );
}

{
  const retiredMainSlashPath = "dist/" + "main.js";
  const retiredMainPatterns = [
    { id: "slash-path", pattern: new RegExp(retiredMainSlashPath.replace("/", "\\/")) },
    { id: "path-join", pattern: /["'`]dist["'`]\s*,\s*["'`]main\.js["'`]/ },
  ];
  const allowedRetiredMainEntrypoints = [
    { file: "src/dashboard/command-spec.ts", id: "path-join", lineIncludes: 'join(installRoot, "dist", "main.js")' },
    { file: "src/daemon.test.ts", id: "slash-path", lineIncludes: "node /opt/aimux/dist/main.js" },
    { file: "src/project-takeover.test.ts", id: "slash-path", lineIncludes: "node /opt/aimux/dist/main.js" },
    { file: "src/process-inspector.test.ts", id: "slash-path", lineIncludes: "node /opt/aimux/dist/main.js" },
    { file: "src/runtime-coherence.test.ts", id: "slash-path", lineIncludes: "/opt/aimux/native/local-old/dist/main.js" },
    { file: "src/runtime-coherence.ts", id: "slash-path", lineIncludes: '"/dist/main.js"' },
    { file: "src/runtime-restart.test.ts", id: "slash-path", lineIncludes: "/old/dist/main.js" },
    { file: "src/runtime-restart.test.ts", id: "slash-path", lineIncludes: "node /opt/aimux/dist/main.js" },
  ];
  const violations = [];
  for (const file of ["bin", "scripts", "src"].flatMap((root) => listFiles(root, { skipTests: false }))) {
    if (file === "src/one-shot-node-inventory.test.ts") continue;
    const lines = source(file).split("\n");
    lines.forEach((line, index) => {
      for (const entry of retiredMainPatterns) {
        if (!entry.pattern.test(line)) continue;
        const allowed = allowedRetiredMainEntrypoints.some(
          (candidate) => candidate.file === file && candidate.id === entry.id && line.includes(candidate.lineIncludes),
        );
        if (!allowed) violations.push(`${file}:${index + 1}:${entry.id}`);
      }
    });
  }
  cases.push(
    caseFor({
      id: "one-shot-node-inventory-008",
      name: "keeps the retired main entrypoint quarantined",
      source: "src/one-shot-node-inventory.test.ts",
      input: { api: "retiredMainEntrypointInventory" },
      output: violations,
    }),
  );
}

{
  const processInspectionPatterns = [
    { id: "pid-alive-helper", pattern: /function\s+isPidAlive\s*\(/ },
    { id: "ps-args", pattern: /execFileSync\(\s*["'`]ps["'`][\s\S]{0,160}["'`]args=["'`]/ },
    { id: "ps-stat", pattern: /execFileSync\(\s*["'`]ps["'`][\s\S]{0,160}["'`]stat=["'`]/ },
    { id: "ps-table", pattern: /execFileSync\(\s*["'`]ps["'`][\s\S]{0,160}["'`]-axo["'`]/ },
    { id: "lsof-cwd", pattern: /execFileSync\(\s*["'`]lsof["'`][\s\S]{0,180}["'`]cwd["'`]/ },
  ];
  const allowedProcessInspectionFiles = new Set(["src/process-inspector.ts"]);
  const allowedCommandArgMatchFiles = new Set(["src/process-args.ts", "src/process-inspector.ts"]);
  const violations = [];
  for (const file of ["bin", "scripts", "src"].flatMap((root) => listFiles(root, { skipTests: true }))) {
    const text = source(file);
    for (const entry of processInspectionPatterns) {
      if (entry.pattern.test(text) && !allowedProcessInspectionFiles.has(file)) violations.push(`${file}:${entry.id}`);
    }
    if (text.includes("commandArgValueMatches") && !allowedCommandArgMatchFiles.has(file)) {
      violations.push(`${file}:commandArgValueMatches`);
    }
  }
  cases.push(
    caseFor({
      id: "one-shot-node-inventory-009",
      name: "keeps OS process inspection behind the shared inspector",
      source: "src/one-shot-node-inventory.test.ts",
      input: { api: "processInspectionInventory" },
      output: violations,
    }),
  );
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  sources: [
    "src/core-sidecar-boundary.test.ts",
    "src/runtime-exchange-boundary.test.ts",
    "src/multiplexer/tui-api-boundary.test.ts",
    "src/tui/render/overlay-viewport-contract.test.ts",
    "src/one-shot-node-inventory.test.ts",
  ],
  generatedBy: "scripts/capture-source-boundary-contracts.mjs",
  description: "Source-boundary inventories captured by running the TypeScript boundary scan logic.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
