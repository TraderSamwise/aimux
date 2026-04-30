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
        screen: "workflow",
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
    expect(state.screen).toBe("workflow");
    expect(state.focusedWorktreePath).toBe("/repo/wt-b");
    expect(state.level).toBe("sessions");
  });
});
