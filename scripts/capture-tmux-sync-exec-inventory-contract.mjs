#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const FIXTURE_PATH = new URL("testdata/contracts/v1/tmux/sync-exec-inventory.json", new URL("../", import.meta.url));

const SYNC_TMUX_METHODS = [
  "repairLegacyProjectSessionNames",
  "applyDefaultRootMouseBindings",
  "setCurrentRuntimeContract",
  "listPersistedCommandText",
  "sendClientCarriageReturn",
  "replaceWindowWhenReady",
  "ensureDashboardWindow",
  "ensureTerminalFeature",
  "currentClientSession",
  "ensureProjectSession",
  "setOptionIfSupported",
  "switchClientToTarget",
  "ensureClientSession",
  "ensureLinkedWindow",
  "listManagedWindows",
  "sendCarriageReturn",
  "getWindowMetadata",
  "sendModifiedEnter",
  "setWindowMetadata",
  "configureSession",
  "getReturnSession",
  "getSessionOption",
  "listSessionNames",
  "setReturnSession",
  "setSessionOption",
  "getWindowOption",
  "sendClientEnter",
  "setWindowOption",
  "cancelCopyMode",
  "displayMessage",
  "isWindowActive",
  "captureTarget",
  "isWindowAlive",
  "refreshStatus",
  "respawnWindow",
  "startPanePipe",
  "createWindow",
  "renameWindow",
  "resizeTarget",
  "selectWindow",
  "stopPanePipe",
  "unlinkWindow",
  "isAvailable",
  "killSession",
  "listClients",
  "listWindows",
  "sendFocusIn",
  "getVersion",
  "hasSession",
  "killWindow",
  "sendEscape",
  "sendEnter",
  "sendText",
  "sendKey",
];

const methodPattern = new RegExp(`\\.(?:${SYNC_TMUX_METHODS.join("|")})\\s*\\(`);
const offLoopFiles = new Set(["src/tmux/expose.ts", "src/expose-hot-snapshot-worker.ts"]);
const allowedSyncCallers = [
  "src/agent-prompt-delivery.ts",
  "src/context/context-bridge.ts",
  "src/daemon.ts",
  "src/dashboard/targets.ts",
  "src/expose-control.ts",
  "src/expose-pane-output-tap.ts",
  "src/fast-control.ts",
  "src/install-cleanup.ts",
  "src/lifecycle-orphans.ts",
  "src/main.ts",
  "src/metadata-server.ts",
  "src/metadata-server/dashboard-client-state.ts",
  "src/multiplexer/dashboard-control.ts",
  "src/multiplexer/dashboard-model.ts",
  "src/multiplexer/dashboard-ops.ts",
  "src/multiplexer/dashboard-state-methods.ts",
  "src/multiplexer/dashboard-tail-methods.ts",
  "src/multiplexer/index.ts",
  "src/multiplexer/persistence-methods.ts",
  "src/multiplexer/runtime-guard.ts",
  "src/multiplexer/runtime-lifecycle-methods.ts",
  "src/multiplexer/runtime-state.ts",
  "src/multiplexer/service-state-snapshot.ts",
  "src/multiplexer/services.ts",
  "src/multiplexer/session-launch.ts",
  "src/multiplexer/session-runtime-core.ts",
  "src/runtime-coherence.ts",
  "src/runtime-restart.ts",
  "src/session-bootstrap.ts",
  "src/tmux/doctor.ts",
  "src/tmux/runtime-manager.ts",
  "src/tmux/runtime-stop.ts",
  "src/tmux/session-transport.ts",
  "src/tmux/statusline-artifacts.ts",
  "src/tmux/window-open.ts",
];

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function listSourceFiles() {
  const files = [];
  const skipDirectories = new Set(["node_modules", "dist", "release", ".git"]);
  const visit = (path) => {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (skipDirectories.has(path.split("/").at(-1) ?? "")) return;
      for (const child of readdirSync(path)) visit(join(path, child));
      return;
    }
    if (!stat.isFile()) return;
    const relativePath = relative(ROOT, path);
    if (!relativePath.endsWith(".ts") || relativePath.endsWith(".test.ts")) return;
    files.push(relativePath);
  };
  visit(join(ROOT, "src"));
  return files.sort();
}

function record(id, name, input, output) {
  return {
    id,
    name,
    source: "src/tmux/sync-exec-inventory.test.ts",
    input,
    output,
    inputSha256: hash(input),
  };
}

const callers = listSourceFiles().filter((file) => methodPattern.test(readFileSync(join(ROOT, file), "utf8")));
const cases = [
  record(
    "tmux-sync-exec-inventory-001",
    "are confined to the files that already had them",
    { api: "syncTmuxCallers", allowedSyncCallers, offLoopFiles: [...offLoopFiles], syncTmuxMethods: SYNC_TMUX_METHODS },
    {
      callers,
      unexpected: callers.filter((file) => !allowedSyncCallers.includes(file) && !offLoopFiles.has(file)),
    },
  ),
  record("tmux-sync-exec-inventory-002", "stays sorted, so adding a line is never the path of least resistance", { api: "allowedSorted", allowedSyncCallers }, {
    sorted: [...allowedSyncCallers].sort(),
    isSorted: JSON.stringify(allowedSyncCallers) === JSON.stringify([...allowedSyncCallers].sort()),
  }),
  record("tmux-sync-exec-inventory-003", "has no duplicate entries, which a Set would have hidden", { api: "allowedDuplicates", allowedSyncCallers }, {
    duplicates: allowedSyncCallers.filter((entry, index) => allowedSyncCallers.indexOf(entry) !== index),
  }),
  record("tmux-sync-exec-inventory-004", "keeps the allowlist honest by failing on entries that no longer apply", { api: "staleAllowed", allowedSyncCallers, syncTmuxMethods: SYNC_TMUX_METHODS }, {
    stale: allowedSyncCallers.filter((file) => !callers.includes(file)),
  }),
  record(
    "tmux-sync-exec-inventory-005",
    "never counts the async form as a synchronous call",
    {
      api: "methodPatternProbes",
      probes: ["await tmux.captureTargetAsync(target)", "tmux.captureTarget(target)"],
      syncTmuxMethods: SYNC_TMUX_METHODS,
    },
    {
      matches: ["await tmux.captureTargetAsync(target)", "tmux.captureTarget(target)"].map((probe) => methodPattern.test(probe)),
    },
  ),
];

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-07T00:00:00.000Z",
  generatedBy: "scripts/capture-tmux-sync-exec-inventory-contract.mjs",
  source: "src/tmux/sync-exec-inventory.test.ts",
  sources: ["src/tmux/sync-exec-inventory.test.ts"],
  description: "Synchronous tmux caller allowlist, stale-entry checks, and async/sync pattern probes captured by running TypeScript source inventory logic.",
  caseCount: cases.length,
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
