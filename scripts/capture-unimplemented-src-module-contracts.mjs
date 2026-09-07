#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/unimplemented/src-modules.json", ROOT);
const VITEST = new URL("node_modules/.bin/vitest", ROOT).pathname;

const MODULES = [
  { source: "src/core-cli.test.ts", missingApi: "Core CLI end-to-end runner and sidecar command execution harness", fence: "core_cli*" },
  { source: "src/core-command-ownership.test.ts", missingApi: "Core command ownership inventory and installed-shim dispatch parity API", fence: "core_cli*" },
  { source: "src/core-project-actor.test.ts", missingApi: "Project actor child-process lifecycle supervisor", fence: "daemon_* / project service actor lifecycle" },
  { source: "src/daemon.test.ts", missingApi: "Daemon HTTP/core-command/expose/project-actor integration surface", fence: "daemon_*" },
  { source: "src/daemon/projects-route.test.ts", missingApi: "Daemon projects route count/cache projection API", fence: "daemon_*" },
  { source: "src/dashboard/command-spec.test.ts", missingApi: "Dashboard command spec compatibility surface for legacy Node dashboard launcher", fence: "dashboard_*" },
  { source: "src/dashboard/targets.test.ts", missingApi: "Dashboard target resolution tmux ownership/focus API", fence: "dashboard_* / tmux*" },
  { source: "src/full/hosted-server.test.ts", missingApi: "Hosted server proxy/rate-limit/audit integration API", fence: "daemon_* / hosted service" },
  { source: "src/metadata-server.interaction.test.ts", missingApi: "Project-service interaction request/watch/respond HTTP API", fence: "project_service/routes/" },
  { source: "src/metadata-server.test.ts", missingApi: "Project-service metadata HTTP route integration API", fence: "project_service/routes/" },
  { source: "src/multiplexer/archives.test.ts", missingApi: "Dashboard archive/graveyard TUI API runtime methods", fence: "dashboard_*" },
  { source: "src/multiplexer/dashboard-control.test.ts", missingApi: "Dashboard control-plane recovery, endpoint validation, and focus API", fence: "dashboard_*" },
  { source: "src/multiplexer/dashboard-interaction.test.ts", missingApi: "Dashboard keyboard interaction state machine", fence: "dashboard_*" },
  { source: "src/multiplexer/dashboard-ops.test.ts", missingApi: "Dashboard service/session operation state machine", fence: "dashboard_*" },
  { source: "src/multiplexer/dashboard-tail-methods.test.ts", missingApi: "Dashboard tail/heartbeat/stream lifecycle methods", fence: "dashboard_*" },
  { source: "src/multiplexer/dashboard-view-methods.test.ts", missingApi: "Dashboard view refresh and stale-render suppression methods", fence: "dashboard_*" },
  { source: "src/multiplexer/desktop-state-golden.test.ts", missingApi: "Desktop-state golden snapshot generator parity API", fence: "dashboard_*" },
  { source: "src/multiplexer/library.test.ts", missingApi: "Dashboard library screen service-backed model API", fence: "dashboard_*" },
  { source: "src/multiplexer/notifications.test.ts", missingApi: "Dashboard notification screen mutation/refresh API", fence: "dashboard_*" },
  { source: "src/multiplexer/persistence-methods.test.ts", missingApi: "Dashboard persistence mutation methods and stale completion guards", fence: "dashboard_*" },
  { source: "src/multiplexer/project.test.ts", missingApi: "Dashboard project screen service-backed model API", fence: "dashboard_*" },
  { source: "src/multiplexer/runtime-state.test.ts", missingApi: "Dashboard runtime-state refresh, restore, backend-id, and idle notification API", fence: "dashboard_* / tmux*" },
  { source: "src/multiplexer/session-launch.test.ts", missingApi: "Managed tmux session launch/resume/relaunch implementation", fence: "tmux* / session_launch.rs" },
  { source: "src/multiplexer/session-runtime-core.test.ts", missingApi: "Managed tmux session runtime core implementation", fence: "tmux*" },
  { source: "src/multiplexer/subscreens.test.ts", missingApi: "Dashboard coordination/archive subscreen state machine", fence: "dashboard_*" },
  { source: "src/multiplexer/topology.test.ts", missingApi: "Dashboard topology screen service-backed model API", fence: "dashboard_*" },
  { source: "src/tmux/attach-terminal-guard.test.ts", missingApi: "tmux attach terminal guard and attach command API", fence: "tmux*" },
  { source: "src/tmux/doctor.test.ts", missingApi: "tmux doctor compatibility report and repair API", fence: "tmux*" },
  { source: "src/tmux/sync-exec-inventory.test.ts", missingApi: "tmux synchronous execution source-inventory guard", fence: "tmux*" },
  { source: "src/tui/screens/overlay-renderers.test.ts", missingApi: "TUI overlay renderer compatibility API", fence: "dashboard_* / terminal/control/render" },
  { source: "src/tui/screens/subscreen-renderers.test.ts", missingApi: "TUI subscreen renderer compatibility API", fence: "dashboard_* / terminal/control/render" },
];

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function normalizeReport(report, source) {
  const result = report.testResults?.find((entry) => entry.name.endsWith(source)) ?? report.testResults?.[0];
  const assertions = (result?.assertionResults ?? []).map((assertion) => ({
    ancestorTitles: assertion.ancestorTitles ?? [],
    title: assertion.title,
    fullName: assertion.fullName,
    status: assertion.status,
    failureMessages: (assertion.failureMessages ?? []).map((message) => normalizeText(message)),
  }));
  return {
    success: Boolean(report.success),
    numTotalTests: report.numTotalTests ?? assertions.length,
    numPassedTests: report.numPassedTests ?? assertions.filter((assertion) => assertion.status === "passed").length,
    numFailedTests: report.numFailedTests ?? assertions.filter((assertion) => assertion.status === "failed").length,
    numPendingTests: report.numPendingTests ?? assertions.filter((assertion) => assertion.status === "pending").length,
    status: result?.status ?? "unknown",
    assertions,
  };
}

function normalizeText(text) {
  return String(text)
    .replaceAll(ROOT.pathname.replace(/\/$/, ""), "<repo>")
    .replace(/\b\d+(?:\.\d+)?ms\b/g, "<duration>")
    .replace(/\b\d{13}\b/g, "<epoch-ms>");
}

function runModule(definition, index) {
  const tempDir = mkdtempSync(join(tmpdir(), "aimux-vitest-contract-"));
  const outputFile = join(tempDir, "report.json");
  try {
    const result = spawnSync(VITEST, ["run", definition.source, "--reporter=json", `--outputFile=${outputFile}`], {
      cwd: ROOT.pathname,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, CI: "1" },
    });
    let report = null;
    try {
      report = JSON.parse(readFileSync(outputFile, "utf8"));
    } catch {
      // Captured below as a runner failure.
    }
    const input = {
      source: definition.source,
      command: ["vitest", "run", definition.source, "--reporter=json"],
    };
    return {
      id: `unimplemented-src-module-${String(index + 1).padStart(3, "0")}`,
      name: definition.source,
      source: definition.source,
      missingApi: definition.missingApi,
      ownershipFence: definition.fence,
      input,
      output: report
        ? normalizeReport(report, definition.source)
        : {
            success: false,
            status: result.error?.code === "ETIMEDOUT" ? "timeout" : "runner-error",
            exitCode: result.status,
            stdout: normalizeText(result.stdout),
            stderr: normalizeText(result.stderr),
            assertions: [],
          },
      inputSha256: hash(input),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const cases = MODULES.map(runModule);
await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-07T00:00:00.000Z",
  generatedBy: "scripts/capture-unimplemented-src-module-contracts.mjs",
  sources: MODULES.map((entry) => entry.source),
  description: "Checklist-only corpora for remaining fenced src test modules captured from normalized Vitest JSON output.",
  caseCount: cases.length,
  assertionCount: cases.reduce((sum, entry) => sum + (entry.output.numTotalTests ?? entry.output.assertions?.length ?? 0), 0),
  cases,
});

const failures = cases.filter((entry) => !entry.output.success);
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} modules, ${cases.reduce((sum, entry) => sum + (entry.output.numTotalTests ?? 0), 0)} tests, ${failures.length} modules failing in TS`);
