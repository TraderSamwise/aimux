#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/dashboard-control-runtime-guard-keys.json", ROOT);

const { handleRuntimeGuardKey } = await import(new URL("dist/multiplexer/dashboard-control.js", ROOT));

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function recorder() {
  const calls = [];
  return {
    calls,
    fn(method, impl) {
      return (...args) => {
        calls.push({ method, args: clone(args) });
        return impl?.(...args);
      };
    },
  };
}

function bufferForKey(key) {
  switch (key) {
    case "enter":
      return Buffer.from("\r");
    case "escape":
      return Buffer.from("\x1b");
    case "right":
      return Buffer.from("\x1b[C");
    case "left":
      return Buffer.from("\x1b[D");
    default:
      return Buffer.from(key);
  }
}

function makeHost(input) {
  const rec = recorder();
  const host = {
    mode: input.mode ?? "dashboard",
    activeIndex: input.activeIndex ?? 0,
    runtimeGuardState: clone(input.runtimeGuardState),
    dashboardBusyState: clone(input.dashboardBusyState ?? null),
    dashboardErrorState: clone(input.dashboardErrorState ?? null),
    dashboardOverlayState: clone(input.dashboardOverlayState ?? { kind: "none" }),
    footerFlash: null,
    footerFlashTicks: 0,
    dashboardState: {
      screen: input.screen ?? "dashboard",
      level: input.level ?? "sessions",
      sessionIndex: input.sessionIndex ?? 0,
      worktreeEntries: clone(input.worktreeEntries ?? []),
      worktreeSessions: clone(input.worktreeSessions ?? []),
      worktreeNavOrder: clone(input.worktreeNavOrder ?? []),
      hasWorktrees: () => input.hasWorktrees === true,
    },
    getDashboardSessions: rec.fn("getDashboardSessions", () => clone(input.dashboardSessions ?? [])),
    renderCurrentDashboardView: rec.fn("renderCurrentDashboardView"),
    tmuxRuntimeManager: input.canFocusLocalTmux
      ? {
          listProjectManagedWindows: rec.fn("tmuxRuntimeManager.listProjectManagedWindows", () => []),
        }
      : {},
  };
  return { host, calls: rec.calls };
}

function runCase(input) {
  const { host, calls } = makeHost(input);
  const handled = handleRuntimeGuardKey(host, bufferForKey(input.key));
  return {
    handled,
    footerFlash: host.footerFlash,
    footerFlashTicks: host.footerFlashTicks,
    calls,
  };
}

const liveSession = { id: "codex-1", status: "running" };
const offlineSession = { id: "codex-2", status: "offline" };

const casesInput = [
  {
    name: "falls through when there is no runtime guard state",
    input: { key: "r" },
  },
  {
    name: "falls through when runtime guard is ok",
    input: { key: "r", runtimeGuardState: { kind: "ok" } },
  },
  {
    name: "busy state owns the key before guard handling",
    input: {
      key: "r",
      runtimeGuardState: { kind: "stale", reason: "service-mismatch" },
      dashboardBusyState: { title: "Repairing Aimux", lines: [], spinnerFrame: 0, startedAt: 1 },
    },
  },
  {
    name: "active overlay owns the key before guard handling",
    input: {
      key: "r",
      runtimeGuardState: { kind: "stale", reason: "service-mismatch" },
      dashboardOverlayState: { kind: "thread-reply" },
    },
  },
  {
    name: "disconnected guard swallows mutating key with reconnecting flash",
    input: { key: "r", runtimeGuardState: { kind: "disconnected" } },
  },
  {
    name: "stale guard swallows mutating key with repair flash",
    input: { key: "n", runtimeGuardState: { kind: "stale", reason: "service-mismatch" } },
  },
  {
    name: "safe movement key falls through while stale",
    input: { key: "j", runtimeGuardState: { kind: "stale", reason: "service-mismatch" } },
  },
  {
    name: "worktree-level enter remains local navigation",
    input: {
      key: "enter",
      runtimeGuardState: { kind: "stale", reason: "service-mismatch" },
      level: "worktrees",
      hasWorktrees: true,
    },
  },
  {
    name: "session-level live session enter remains local navigation",
    input: {
      key: "enter",
      runtimeGuardState: { kind: "stale", reason: "service-mismatch" },
      level: "sessions",
      hasWorktrees: true,
      canFocusLocalTmux: true,
      worktreeEntries: [{ kind: "session", id: "codex-1" }],
      worktreeSessions: [liveSession],
    },
  },
  {
    name: "session-level offline session enter is swallowed",
    input: {
      key: "enter",
      runtimeGuardState: { kind: "stale", reason: "service-mismatch" },
      level: "sessions",
      hasWorktrees: true,
      canFocusLocalTmux: true,
      worktreeEntries: [{ kind: "session", id: "codex-2" }],
      worktreeSessions: [offlineSession],
    },
  },
  {
    name: "session-level service enter remains local navigation when tmux focus is available",
    input: {
      key: "enter",
      runtimeGuardState: { kind: "stale", reason: "service-mismatch" },
      level: "sessions",
      hasWorktrees: true,
      canFocusLocalTmux: true,
      worktreeEntries: [{ kind: "service", id: "svc-1" }],
    },
  },
  {
    name: "session-level service enter is swallowed without local tmux focus",
    input: {
      key: "enter",
      runtimeGuardState: { kind: "stale", reason: "service-mismatch" },
      level: "sessions",
      hasWorktrees: true,
      canFocusLocalTmux: false,
      worktreeEntries: [{ kind: "service", id: "svc-1" }],
    },
  },
  {
    name: "ungrouped live session enter remains local navigation",
    input: {
      key: "enter",
      runtimeGuardState: { kind: "stale", reason: "service-mismatch" },
      hasWorktrees: false,
      canFocusLocalTmux: true,
      dashboardSessions: [liveSession],
    },
  },
  {
    name: "ungrouped offline session enter is swallowed",
    input: {
      key: "enter",
      runtimeGuardState: { kind: "stale", reason: "service-mismatch" },
      hasWorktrees: false,
      canFocusLocalTmux: true,
      dashboardSessions: [offlineSession],
    },
  },
];

const cases = [];
for (const [index, entry] of casesInput.entries()) {
  const input = clone(entry.input);
  cases.push({
    id: `dashboard-control-runtime-guard-keys-${String(index + 1).padStart(3, "0")}`,
    name: entry.name,
    source: "src/multiplexer/dashboard-control.ts",
    api: "handleRuntimeGuardKey",
    input,
    output: runCase(clone(input)),
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/dashboard-control.ts",
  generatedBy: "scripts/capture-dashboard-control-runtime-guard-keys-contract.mjs",
  description:
    "Dashboard-control runtime guard key interception and local navigation pass-through side effects captured by running TypeScript handleRuntimeGuardKey.",
  cases,
});
