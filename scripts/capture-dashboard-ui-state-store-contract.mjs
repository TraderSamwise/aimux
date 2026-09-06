#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/runtime-state/dashboard-ui-state-store.json", ROOT);

const { initPaths, getDashboardClientUiStatePath, getDashboardUiStatePath } = await import(
  new URL("dist/paths.js", ROOT)
);
const { DashboardState } = await import(new URL("dist/dashboard/state.js", ROOT));
const { DashboardUiStateStore } = await import(new URL("dist/dashboard/ui-state-store.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

async function maybeJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function withRepo(run) {
  const repoRoot = await mkdtemp(join(tmpdir(), "aimux-dashboard-ui-state-"));
  await mkdir(join(repoRoot, ".git"), { recursive: true });
  try {
    await initPaths(repoRoot);
    return await run();
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

function stateSnapshot(state) {
  return {
    screen: state.screen,
    detailsSidebarVisible: state.detailsSidebarVisible,
    focusedWorktreePath: state.focusedWorktreePath,
    level: state.level,
    sessionIndex: state.sessionIndex,
    previewSource: state.previewSource,
    worktreeEntries: state.worktreeEntries,
  };
}

const cases = [];
async function record(name, input, run) {
  const output = await withRepo(run);
  cases.push({
    id: `runtime-state-dashboard-ui-state-store-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/dashboard/ui-state-store.test.ts",
    sourceName: name,
    api: "DashboardUiStateStore",
    input,
    output,
    inputSha256: hash(input),
  });
}

await record(
  "persists shared prefs separately from client-scoped transient state",
  { clientId: "client-a" },
  async () => {
    const store = new DashboardUiStateStore();
    const state = new DashboardState();
    state.screen = "activity";
    state.detailsSidebarVisible = false;
    state.focusedWorktreePath = "/repo/wt";
    state.level = "sessions";
    state.worktreeEntries = [{ kind: "session", id: "claude-1" }];
    state.sessionIndex = 0;
    store.persist("dashboard", "client-a", state, 0, [{ id: "claude-1" }]);
    return {
      shared: await maybeJson(getDashboardUiStatePath()),
      client: await maybeJson(getDashboardClientUiStatePath("client-a")),
    };
  },
);

await record(
  "loads shared prefs and client transient state independently",
  { clients: ["client-a", "client-b"], loadClient: "client-b" },
  async () => {
    const state = new DashboardState();
    const store = new DashboardUiStateStore();
    store.persist(
      "dashboard",
      "client-a",
      Object.assign(new DashboardState(), {
        screen: "threads",
        detailsSidebarVisible: false,
        focusedWorktreePath: "/repo/wt-a",
        level: "sessions",
        worktreeEntries: [{ kind: "session", id: "claude-a" }],
        sessionIndex: 0,
      }),
      0,
      [{ id: "claude-a" }],
    );
    store.persist(
      "dashboard",
      "client-b",
      Object.assign(new DashboardState(), {
        screen: "coordination",
        detailsSidebarVisible: false,
        focusedWorktreePath: "/repo/wt-b",
        level: "sessions",
        worktreeEntries: [{ kind: "session", id: "claude-b" }],
        sessionIndex: 0,
      }),
      0,
      [{ id: "claude-b" }],
    );
    store.loadInto(state, "client-b");
    return { state: stateSnapshot(state) };
  },
);

await record("persists and loads the shared dashboard preview source", { previewSource: "scribe" }, async () => {
  const writer = new DashboardUiStateStore();
  writer.persist("dashboard", "client-a", Object.assign(new DashboardState(), { previewSource: "scribe" }), 0, []);
  const state = new DashboardState();
  new DashboardUiStateStore().loadSharedState(state);
  return { state: stateSnapshot(state), shared: await maybeJson(getDashboardUiStatePath()) };
});

await record(
  "normalizes an invalid persisted preview source to output",
  { previewSource: "bogus", initialPreviewSource: "scribe" },
  async () => {
    const writer = new DashboardUiStateStore();
    writer.persist("dashboard", "client-a", Object.assign(new DashboardState(), { previewSource: "bogus" }), 0, []);
    const state = new DashboardState();
    state.previewSource = "scribe";
    new DashboardUiStateStore().loadSharedState(state);
    return { state: stateSnapshot(state), shared: await maybeJson(getDashboardUiStatePath()) };
  },
);

await record(
  "migrates a pre-merge persisted screen (workflow/threads/notifications) onto coordination",
  { persistedScreen: "workflow" },
  async () => {
    const store = new DashboardUiStateStore();
    store.persist("dashboard", "legacy", Object.assign(new DashboardState(), { screen: "workflow" }), 0, []);
    const state = new DashboardState();
    store.loadInto(state, "legacy");
    return { state: stateSnapshot(state) };
  },
);

await record(
  "falls back to the dashboard for an unrecognized persisted screen",
  { persistedScreen: "bogus", initialScreen: "activity" },
  async () => {
    const store = new DashboardUiStateStore();
    store.persist("dashboard", "weird", Object.assign(new DashboardState(), { screen: "bogus" }), 0, []);
    const state = new DashboardState();
    state.screen = "activity";
    store.loadInto(state, "weird");
    return { state: stateSnapshot(state) };
  },
);

await record(
  "re-arms selection restore when a preferred entry is loaded from client state",
  { persistedSelectedEntryId: "claude-1" },
  async () => {
    const persisted = Object.assign(new DashboardState(), {
      focusedWorktreePath: "/repo/wt",
      level: "sessions",
      worktreeEntries: [{ kind: "session", id: "claude-1" }],
      sessionIndex: 0,
    });
    const writer = new DashboardUiStateStore();
    writer.persist("dashboard", "client-a", persisted, 0, [{ id: "claude-1" }]);
    const state = new DashboardState();
    state.focusedWorktreePath = "/repo/wt";
    state.level = "sessions";
    state.worktreeEntries = [
      { kind: "session", id: "other-0" },
      { kind: "session", id: "claude-1" },
    ];
    state.sessionIndex = 0;
    const store = new DashboardUiStateStore();
    store.markSelectionDirty();
    store.consumeSelectionRestore(state, [], true, 0, () => undefined);
    const beforeLoadIndex = state.sessionIndex;
    store.loadInto(state, "client-a");
    store.consumeSelectionRestore(state, [], true, 0, () => undefined);
    return { beforeLoadIndex, afterLoadIndex: state.sessionIndex, state: stateSnapshot(state) };
  },
);

await record(
  "keeps command-requested selection pending until the optimistic entry appears",
  { preferredEntryId: "new-agent" },
  async () => {
    const state = new DashboardState();
    state.level = "sessions";
    state.focusedWorktreePath = "/repo/wt";
    state.worktreeEntries = [{ kind: "session", id: "old-agent" }];
    state.sessionIndex = 0;
    const store = new DashboardUiStateStore();
    store.preferEntrySelection(state, "session", "new-agent", "/repo/wt");
    store.consumeSelectionRestore(state, [], true, 0, () => undefined);
    const beforeEntryAppears = state.sessionIndex;
    state.worktreeEntries = [
      { kind: "session", id: "new-agent" },
      { kind: "session", id: "old-agent" },
    ];
    store.consumeSelectionRestore(state, [], true, 0, () => undefined);
    return { beforeEntryAppears, afterEntryAppears: state.sessionIndex, state: stateSnapshot(state) };
  },
);

await record(
  "keeps command-requested selection pending across temporary non-session views",
  { preferredEntryId: "new-agent" },
  async () => {
    const state = new DashboardState();
    state.level = "sessions";
    state.focusedWorktreePath = "/repo/wt";
    state.worktreeEntries = [{ kind: "session", id: "old-agent" }];
    state.sessionIndex = 0;
    const store = new DashboardUiStateStore();
    store.preferEntrySelection(state, "session", "new-agent", "/repo/wt");
    state.level = "worktrees";
    store.consumeSelectionRestore(state, [], true, 0, () => undefined);
    const duringWorktreeView = state.sessionIndex;
    state.level = "sessions";
    state.worktreeEntries = [
      { kind: "session", id: "old-agent" },
      { kind: "session", id: "new-agent" },
    ];
    store.consumeSelectionRestore(state, [], true, 0, () => undefined);
    return { duringWorktreeView, afterSessionView: state.sessionIndex, state: stateSnapshot(state) };
  },
);

await record(
  "does not keep stale persisted selection pending when the entry is gone",
  { persistedSelectedEntryId: "gone-agent" },
  async () => {
    const writer = new DashboardUiStateStore();
    writer.persist(
      "dashboard",
      "client-a",
      Object.assign(new DashboardState(), {
        focusedWorktreePath: "/repo/wt",
        level: "sessions",
        worktreeEntries: [{ kind: "session", id: "gone-agent" }],
        sessionIndex: 0,
      }),
      0,
      [{ id: "gone-agent" }],
    );
    const state = new DashboardState();
    state.level = "sessions";
    state.focusedWorktreePath = "/repo/wt";
    state.worktreeEntries = [{ kind: "session", id: "remaining-agent" }];
    state.sessionIndex = 0;
    const store = new DashboardUiStateStore();
    store.loadInto(state, "client-a");
    store.consumeSelectionRestore(state, [], true, 0, () => undefined);
    const afterMissingEntry = state.sessionIndex;
    state.worktreeEntries = [
      { kind: "session", id: "later-agent" },
      { kind: "session", id: "remaining-agent" },
    ];
    store.consumeSelectionRestore(state, [], true, 0, () => undefined);
    return { afterMissingEntry, afterLaterRefresh: state.sessionIndex, state: stateSnapshot(state) };
  },
);

await record(
  "keeps a manually remembered entry stable across refresh restore",
  { manualEntryId: "manual-agent" },
  async () => {
    const writer = new DashboardUiStateStore();
    writer.persist(
      "dashboard",
      "client-a",
      Object.assign(new DashboardState(), {
        focusedWorktreePath: "/repo/wt",
        level: "sessions",
        worktreeEntries: [{ kind: "session", id: "old-agent" }],
        sessionIndex: 0,
      }),
      0,
      [{ id: "old-agent" }],
    );
    const state = new DashboardState();
    state.level = "sessions";
    state.focusedWorktreePath = "/repo/wt";
    state.worktreeEntries = [
      { kind: "session", id: "old-agent" },
      { kind: "session", id: "manual-agent" },
    ];
    state.sessionIndex = 1;
    const store = new DashboardUiStateStore();
    store.loadInto(state, "client-a");
    store.rememberCurrentEntrySelection(state);
    state.worktreeEntries = [
      { kind: "session", id: "inserted-agent" },
      { kind: "session", id: "old-agent" },
      { kind: "session", id: "manual-agent" },
    ];
    state.sessionIndex = 1;
    store.markSelectionDirty();
    store.consumeSelectionRestore(state, [], true, 0, () => undefined);
    return { finalIndex: state.sessionIndex, state: stateSnapshot(state) };
  },
);

await record(
  "persists and reloads shared dashboard item order",
  { move: { kind: "session", selectedId: "agent-a", direction: "down" } },
  async () => {
    const store = new DashboardUiStateStore();
    const state = new DashboardState();
    const moved = store.moveEntryWithinWorktree({
      kind: "session",
      worktreePath: "/repo/wt",
      selectedId: "agent-a",
      direction: "down",
      sessions: [{ id: "agent-a" }, { id: "agent-b" }],
      services: [],
    });
    store.persist("dashboard", "client-a", state, 0, []);
    const next = new DashboardUiStateStore();
    next.loadInto(new DashboardState(), "client-a");
    return {
      moved,
      ordered: next.orderSessionsForWorktree([{ id: "agent-a" }, { id: "agent-b" }], "/repo/wt"),
      shared: await maybeJson(getDashboardUiStatePath()),
    };
  },
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/dashboard/ui-state-store.test.ts",
  generatedBy: "scripts/capture-dashboard-ui-state-store-contract.mjs",
  description:
    "Dashboard UI state shared/client persistence, screen normalization, selection restore, and item ordering behavior captured by running TypeScript DashboardUiStateStore.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
