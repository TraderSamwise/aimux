#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/session-launch-actions.json", ROOT);

const { focusSession, getScopedSessionEntries, handleAction } = await import(
  new URL("dist/multiplexer/session-launch.js", ROOT)
);

const cwd = process.cwd();
const clone = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeValue(value) {
  return JSON.parse(JSON.stringify(value).split(cwd).join("<REPO>"));
}

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function recorder() {
  const calls = [];
  return {
    calls,
    fn(name, impl) {
      return (...args) => {
        calls.push({ method: name, args: clone(args) });
        return impl?.(...args);
      };
    },
  };
}

function mapToPairs(map) {
  return [...map.entries()].map(([key, value]) => [key, value]);
}

function focusHost(input) {
  const rec = recorder();
  const targets = new Map((input.targets ?? []).map(([sessionId, target]) => [sessionId, clone(target)]));
  const resolvedTargets = new Map((input.resolvedTargets ?? []).map(([windowId, target]) => [windowId, clone(target)]));
  const metadata = new Map((input.metadata ?? []).map(([windowId, value]) => [windowId, clone(value)]));
  const host = {
    projectRoot: input.projectRoot,
    sessions: clone(input.sessions ?? []),
    activeIndex: input.activeIndex ?? 0,
    sessionMRU: clone(input.sessionMRU ?? []),
    sessionTmuxTargets: targets,
    tmuxRuntimeManager: {
      getTargetByWindowId: rec.fn("tmuxRuntimeManager.getTargetByWindowId", (_sessionName, windowId) => {
        const value = resolvedTargets.get(windowId);
        return value === null ? undefined : value;
      }),
      getWindowMetadata: rec.fn("tmuxRuntimeManager.getWindowMetadata", (target) => {
        const value = metadata.get(target.windowId);
        return value === undefined ? null : value;
      }),
      listProjectManagedWindows: rec.fn("tmuxRuntimeManager.listProjectManagedWindows", () =>
        clone(input.projectWindows ?? []),
      ),
      isWindowAlive: rec.fn("tmuxRuntimeManager.isWindowAlive", (target) => target.alive !== false),
    },
    selectLinkedOrOpenTarget: rec.fn("selectLinkedOrOpenTarget"),
    openLiveTmuxWindowForEntry: rec.fn("openLiveTmuxWindowForEntry", () => input.openResult ?? "missing"),
    noteLastUsedItem: rec.fn("noteLastUsedItem"),
    saveState: rec.fn("saveState"),
    postToProjectService: rec.fn("postToProjectService", async () => ({ ok: true })),
  };
  return { host, calls: rec.calls };
}

async function runFocusCase(input) {
  const { host, calls } = focusHost(input);
  focusSession(host, input.index);
  await sleep(10);
  return {
    activeIndex: host.activeIndex,
    sessionMRU: host.sessionMRU,
    targets: mapToPairs(host.sessionTmuxTargets),
    calls,
  };
}

function actionHost(input) {
  const rec = recorder();
  const host = {
    sessions: clone(input.sessions ?? []),
    activeIndex: input.activeIndex ?? 0,
    getScopedSessionEntries() {
      return getScopedSessionEntries(this);
    },
    openTmuxDashboardTarget: rec.fn("openTmuxDashboardTarget"),
    clearDashboardSubscreens: rec.fn("clearDashboardSubscreens"),
    setDashboardScreen: rec.fn("setDashboardScreen"),
    persistDashboardUiState: rec.fn("persistDashboardUiState"),
    refreshCoordinationFromService: rec.fn("refreshCoordinationFromService", async () => ({})),
    showHelp: rec.fn("showHelp"),
    focusSession: rec.fn("focusSession"),
    showToolPicker: rec.fn("showToolPicker"),
    showSwitcher: rec.fn("showSwitcher"),
    showWorktreeCreatePrompt: rec.fn("showWorktreeCreatePrompt"),
    showWorktreeList: rec.fn("showWorktreeList"),
    showWorkOutlineOverlay: rec.fn("showWorkOutlineOverlay"),
    handleReviewRequest: rec.fn("handleReviewRequest", async () => ({})),
  };
  for (const session of host.sessions) {
    session.kill = rec.fn(`session.${session.id}.kill`);
  }
  return { host, calls: rec.calls };
}

async function runActionCase(input) {
  const { host, calls } = actionHost(input);
  for (const action of input.actions ?? []) {
    handleAction(host, action);
  }
  await sleep(10);
  return {
    activeIndex: host.activeIndex,
    coordinationLoaded: host.coordinationLoaded ?? null,
    calls,
  };
}

const focusCases = [
  {
    name: "opens fallback live target without durable backend id",
    input: {
      sessions: [{ id: "claude-1" }, { id: "codex-2" }],
      activeIndex: 1,
      sessionMRU: ["codex-2"],
      targets: [],
      openResult: "opened",
      index: 0,
    },
  },
  {
    name: "uses current cached tmux target before fallback open",
    input: {
      sessions: [{ id: "claude-1" }, { id: "codex-2" }],
      activeIndex: 1,
      sessionMRU: ["codex-2"],
      targets: [["claude-1", { sessionName: "aimux-test", windowId: "@1", windowName: "claude" }]],
      resolvedTargets: [["@1", { sessionName: "aimux-test", windowId: "@1", windowName: "claude" }]],
      metadata: [["@1", { kind: "agent", sessionId: "claude-1" }]],
      openResult: "missing",
      index: 0,
    },
  },
  {
    name: "drops stale target and does not mark focus when fallback is missing",
    input: {
      sessions: [{ id: "claude-1" }, { id: "codex-2" }],
      activeIndex: 1,
      sessionMRU: ["codex-2"],
      targets: [["claude-1", { sessionName: "aimux-test", windowId: "@2", windowName: "claude" }]],
      resolvedTargets: [["@2", null]],
      projectWindows: [],
      openResult: "missing",
      index: 0,
    },
  },
  {
    name: "rejects cached tmux target owned by another agent",
    input: {
      sessions: [{ id: "claude-1" }, { id: "codex-2" }],
      activeIndex: 1,
      sessionMRU: ["codex-2"],
      targets: [["claude-1", { sessionName: "aimux-test", windowId: "@3", windowName: "claude" }]],
      resolvedTargets: [["@3", { sessionName: "aimux-test", windowId: "@3", windowName: "claude" }]],
      metadata: [["@3", { kind: "agent", sessionId: "codex-2" }]],
      projectWindows: [],
      openResult: "missing",
      index: 0,
    },
  },
  {
    name: "ignores out of range focus index",
    input: {
      sessions: [{ id: "claude-1" }],
      activeIndex: 0,
      sessionMRU: ["claude-1"],
      targets: [],
      index: 5,
    },
  },
];

const actionCases = [
  {
    name: "basic dashboard commands dispatch host methods",
    input: {
      sessions: [{ id: "codex-1" }, { id: "claude-2" }],
      activeIndex: 0,
      actions: [
        { type: "dashboard" },
        { type: "help" },
        { type: "create" },
        { type: "switcher" },
        { type: "worktree-create" },
        { type: "worktree-list" },
        { type: "kill" },
        { type: "review" },
      ],
    },
  },
  {
    name: "coordination action opens dashboard and refreshes service view",
    input: {
      sessions: [{ id: "codex-1" }],
      activeIndex: 0,
      actions: [{ type: "coordination" }],
    },
  },
  {
    name: "work outline opens dashboard before selected human session outline",
    input: {
      sessions: [{ id: "codex-1" }],
      activeIndex: 0,
      actions: [{ type: "work-outline" }],
    },
  },
  {
    name: "work outline omits project control active session",
    input: {
      sessions: [{ id: "claude-scribe", team: { role: "scribe" } }],
      activeIndex: 0,
      actions: [{ type: "work-outline" }],
    },
  },
  {
    name: "leader navigation skips project control sessions",
    input: {
      sessions: [
        { id: "codex-1" },
        { id: "claude-scribe", team: { role: "scribe" } },
        { id: "claude-overseer", team: { role: "overseer" } },
        { id: "claude-2" },
      ],
      activeIndex: 0,
      actions: [{ type: "next" }, { type: "prev" }, { type: "focus", index: 1 }],
    },
  },
  {
    name: "leader navigation does not move from focused project control session",
    input: {
      sessions: [{ id: "codex-1" }, { id: "claude-scribe", team: { role: "scribe" } }, { id: "claude-2" }],
      activeIndex: 1,
      actions: [{ type: "next" }, { type: "prev" }],
    },
  },
];

const cases = [];
for (const entry of focusCases) {
  const input = normalizeValue(entry.input);
  cases.push({
    id: `session-launch-actions-${String(cases.length + 1).padStart(3, "0")}`,
    name: entry.name,
    source: "src/multiplexer/session-launch.ts",
    api: "focusSession",
    input,
    output: normalizeValue(await runFocusCase(clone(entry.input))),
    inputSha256: hash(input),
  });
}
for (const entry of actionCases) {
  const input = normalizeValue(entry.input);
  cases.push({
    id: `session-launch-actions-${String(cases.length + 1).padStart(3, "0")}`,
    name: entry.name,
    source: "src/multiplexer/session-launch.ts",
    api: "handleAction",
    input,
    output: normalizeValue(await runActionCase(clone(entry.input))),
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/session-launch.ts",
  generatedBy: "scripts/capture-session-launch-actions-contract.mjs",
  description:
    "Session launch focus and dashboard leader action side effects captured by running TypeScript session-launch helpers with deterministic fake hosts.",
  cases,
});
