import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { initPaths, getDashboardClientUiStatePath, getDashboardUiStatePath } from "../paths.js";
import { DashboardState } from "./state.js";
import { DashboardUiStateStore } from "./ui-state-store.js";

describe("DashboardUiStateStore", () => {
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-dashboard-ui-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("persists shared prefs separately from client-scoped transient state", () => {
    const store = new DashboardUiStateStore();
    const state = new DashboardState();
    state.screen = "activity";
    state.detailsSidebarVisible = false;
    state.focusedWorktreePath = "/repo/wt";
    state.level = "sessions";
    state.worktreeEntries = [{ kind: "session", id: "claude-1" }];
    state.sessionIndex = 0;

    store.persist("dashboard", "client-a", state, 0, [{ id: "claude-1" } as any]);

    const shared = JSON.parse(readFileSync(getDashboardUiStatePath(), "utf-8"));
    const client = JSON.parse(readFileSync(getDashboardClientUiStatePath("client-a"), "utf-8"));

    expect(shared).toEqual({ detailsSidebarVisible: false });
    expect(client).toMatchObject({
      screen: "activity",
      focusedWorktreePath: "/repo/wt",
      level: "sessions",
      selectedEntryKind: "session",
      selectedEntryId: "claude-1",
      flatSessionId: "claude-1",
    });
  });

  it("loads shared prefs and client transient state independently", () => {
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
      [{ id: "claude-a" } as any],
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
      [{ id: "claude-b" } as any],
    );

    store.loadInto(state, "client-b");

    expect(state.detailsSidebarVisible).toBe(false);
    expect(state.screen).toBe("coordination");
    expect(state.focusedWorktreePath).toBe("/repo/wt-b");
    expect(state.level).toBe("sessions");
  });

  it("migrates a pre-merge persisted screen (workflow/threads/notifications) onto coordination", () => {
    const store = new DashboardUiStateStore();
    store.persist("dashboard", "legacy", Object.assign(new DashboardState(), { screen: "workflow" as any }), 0, []);

    const state = new DashboardState();
    store.loadInto(state, "legacy");
    expect(state.screen).toBe("coordination");
  });

  it("falls back to the dashboard for an unrecognized persisted screen", () => {
    const store = new DashboardUiStateStore();
    store.persist("dashboard", "weird", Object.assign(new DashboardState(), { screen: "bogus" as any }), 0, []);

    const state = new DashboardState();
    state.screen = "activity";
    store.loadInto(state, "weird");
    expect(state.screen).toBe("dashboard");
  });

  it("re-arms selection restore when a preferred entry is loaded from client state", () => {
    const persisted = Object.assign(new DashboardState(), {
      focusedWorktreePath: "/repo/wt",
      level: "sessions",
      worktreeEntries: [{ kind: "session", id: "claude-1" }],
      sessionIndex: 0,
    });

    const writer = new DashboardUiStateStore();
    writer.persist("dashboard", "client-a", persisted, 0, [{ id: "claude-1" } as any]);

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
    expect(state.sessionIndex).toBe(0);

    store.loadInto(state, "client-a");
    store.consumeSelectionRestore(state, [], true, 0, () => undefined);
    expect(state.sessionIndex).toBe(1);
  });

  it("keeps command-requested selection pending until the optimistic entry appears", () => {
    const state = new DashboardState();
    state.level = "sessions";
    state.focusedWorktreePath = "/repo/wt";
    state.worktreeEntries = [{ kind: "session", id: "old-agent" }];
    state.sessionIndex = 0;

    const store = new DashboardUiStateStore();
    store.preferEntrySelection(state, "session", "new-agent", "/repo/wt");
    store.consumeSelectionRestore(state, [], true, 0, () => undefined);

    expect(state.sessionIndex).toBe(0);

    state.worktreeEntries = [
      { kind: "session", id: "new-agent" },
      { kind: "session", id: "old-agent" },
    ];
    store.consumeSelectionRestore(state, [], true, 0, () => undefined);

    expect(state.sessionIndex).toBe(0);
  });

  it("does not keep stale persisted selection pending when the entry is gone", () => {
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
      [{ id: "gone-agent" } as any],
    );

    const state = new DashboardState();
    state.level = "sessions";
    state.focusedWorktreePath = "/repo/wt";
    state.worktreeEntries = [{ kind: "session", id: "remaining-agent" }];
    state.sessionIndex = 0;

    const store = new DashboardUiStateStore();
    store.loadInto(state, "client-a");
    store.consumeSelectionRestore(state, [], true, 0, () => undefined);

    state.worktreeEntries = [
      { kind: "session", id: "later-agent" },
      { kind: "session", id: "remaining-agent" },
    ];
    store.consumeSelectionRestore(state, [], true, 0, () => undefined);

    expect(state.sessionIndex).toBe(0);
  });

  it("persists and reloads shared dashboard item order", () => {
    const store = new DashboardUiStateStore();
    const state = new DashboardState();

    expect(
      store.moveEntryWithinWorktree({
        kind: "session",
        worktreePath: "/repo/wt",
        selectedId: "agent-a",
        direction: "down",
        sessions: [{ id: "agent-a" }, { id: "agent-b" }] as any,
        services: [],
      }),
    ).toBe(true);
    store.persist("dashboard", "client-a", state, 0, []);

    const next = new DashboardUiStateStore();
    next.loadInto(new DashboardState(), "client-a");

    expect(next.orderSessionsForWorktree([{ id: "agent-a" }, { id: "agent-b" }] as any, "/repo/wt")).toEqual([
      { id: "agent-b" },
      { id: "agent-a" },
    ]);
  });
});
