import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Which files are allowed to call tmux synchronously.
 *
 * A synchronous tmux call forks a process and blocks this event loop until it
 * returns. The daemon hosts every project service in one process, so that is dead
 * time for every project — measured at 6.8-9.9% of wall time, with the daemon's
 * own `/health` sitting behind it.
 *
 * The obvious gate — "no timer-driven module may call tmux synchronously" — is
 * not statically detectable: the timer and the call are several hops and files
 * apart. So this inverts it. Every file naming a synchronous tmux method is
 * listed, and the list is meant to shrink. Adding an entry is the deliberate act;
 * adding a call is not.
 */

// Longest-first, so `listWindows` cannot shadow `listProjectManagedWindows` in
// the alternation. Every method whose body reaches this.exec() is here: a partial
// list is not a weaker gate, it is a documented bypass.
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
] as const;

// `captureTarget` is a prefix of `captureTargetAsync`, and `displayMessage` of no
// other member — but the async form must never satisfy the sync pattern, so the
// boundary is explicit rather than assumed.
const methodPattern = new RegExp(`\\.(?:${SYNC_TMUX_METHODS.join("|")})\\s*\\(`);

/**
 * Permanent exemptions: neither runs on the daemon's event loop.
 *
 * The Exposé popup is its own process, and the hot-snapshot refresh is a worker
 * thread — the same two blind spots `/diagnostics/loop` names in its payload.
 */
const OFF_LOOP_FILES = new Set(["src/tmux/expose.ts", "src/expose-hot-snapshot-worker.ts"]);

/**
 * On the daemon loop and still synchronous. Every entry is a known cost; the list
 * is a worklist, not a permission slip.
 */
const ALLOWED_SYNC_CALLERS = [
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

const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "release", ".git"]);
// fileURLToPath, not .pathname: the latter stays percent-encoded, so a checkout
// under a path containing a space resolves to a directory that does not exist.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function listSourceFiles(): string[] {
  const files: string[] = [];
  const visit = (path: string) => {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (SKIP_DIRECTORIES.has(path.split("/").at(-1) ?? "")) return;
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

describe("synchronous tmux callers", () => {
  const callers = listSourceFiles().filter((file) => methodPattern.test(readFileSync(join(ROOT, file), "utf8")));

  it("are confined to the files that already had them", () => {
    const unexpected = callers.filter((file) => !ALLOWED_SYNC_CALLERS.includes(file) && !OFF_LOOP_FILES.has(file));
    expect(unexpected).toEqual([]);
  });

  it("stays sorted, so adding a line is never the path of least resistance", () => {
    const entries = ALLOWED_SYNC_CALLERS;
    expect(entries).toEqual([...entries].sort());
  });

  it("has no duplicate entries, which a Set would have hidden", () => {
    expect(ALLOWED_SYNC_CALLERS).toEqual([...new Set(ALLOWED_SYNC_CALLERS)]);
  });

  it("keeps the allowlist honest by failing on entries that no longer apply", () => {
    // A stale entry silently readmits a file that was cleaned up, which is how an
    // allowlist stops meaning anything.
    const stale = ALLOWED_SYNC_CALLERS.filter((file) => !callers.includes(file));
    expect(stale).toEqual([]);
  });

  it("never counts the async form as a synchronous call", () => {
    expect(methodPattern.test("await tmux.captureTargetAsync(target)")).toBe(false);
    expect(methodPattern.test("tmux.captureTarget(target)")).toBe(true);
  });
});
