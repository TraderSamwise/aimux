import { describe, expect, it } from "vitest";
import type { DashboardService, DashboardSession, WorktreeGroup } from "./index.js";
import { filterDashboardVisibleModel, isDashboardSessionOffline } from "./visibility.js";

function session(overrides: Partial<DashboardSession>): DashboardSession {
  return {
    index: 0,
    id: overrides.id ?? "session",
    command: overrides.command ?? "codex",
    status: overrides.status ?? "running",
    active: overrides.active ?? true,
    ...overrides,
  };
}

function service(overrides: Partial<DashboardService>): DashboardService {
  return {
    id: overrides.id ?? "service",
    command: overrides.command ?? "yarn dev",
    args: [],
    status: overrides.status ?? "running",
    active: overrides.active ?? true,
    ...overrides,
  };
}

function group(overrides: Partial<WorktreeGroup>): WorktreeGroup {
  return {
    name: overrides.name ?? "main",
    branch: overrides.branch ?? "master",
    status: overrides.status ?? "active",
    sessions: overrides.sessions ?? [],
    services: overrides.services ?? [],
    ...overrides,
  };
}

describe("dashboard visibility filtering", () => {
  it("treats raw and semantic offline sessions as offline but keeps pending actions visible", () => {
    expect(isDashboardSessionOffline(session({ status: "offline" }))).toBe(true);
    expect(
      isDashboardSessionOffline(session({ status: "running", semantic: { user: { label: "offline" } } as never })),
    ).toBe(true);
    expect(isDashboardSessionOffline(session({ status: "offline", pendingAction: "starting" }))).toBe(false);
  });

  it("returns the original model when the toggle is off", () => {
    const sessions = [session({ id: "offline", status: "offline" })];
    const services = [service({ id: "svc" })];
    const worktreeGroups = [group({ sessions })];

    expect(filterDashboardVisibleModel({ hideOfflineAgents: false, sessions, services, worktreeGroups })).toEqual({
      sessions,
      services,
      worktreeGroups,
    });
  });

  it("hides offline agents and worktrees with no online agents", () => {
    const online = session({ id: "online", worktreePath: "/repo/.aimux/worktrees/live" });
    const offline = session({ id: "offline", status: "offline", worktreePath: "/repo/.aimux/worktrees/dead" });
    const liveService = service({ id: "live-svc", worktreePath: "/repo/.aimux/worktrees/live" });
    const deadService = service({ id: "dead-svc", worktreePath: "/repo/.aimux/worktrees/dead" });

    const result = filterDashboardVisibleModel({
      hideOfflineAgents: true,
      sessions: [online, offline],
      services: [liveService, deadService],
      worktreeGroups: [
        group({ name: "live", path: "/repo/.aimux/worktrees/live", sessions: [online], services: [liveService] }),
        group({ name: "dead", path: "/repo/.aimux/worktrees/dead", sessions: [offline], services: [deadService] }),
      ],
    });

    expect(result.sessions.map((entry) => entry.id)).toEqual(["online"]);
    expect(result.services.map((entry) => entry.id)).toEqual(["live-svc"]);
    expect(result.worktreeGroups.map((entry) => entry.name)).toEqual(["live"]);
  });

  it("keeps pending worktree operation rows visible without offline agents", () => {
    const offline = session({ id: "offline", status: "offline", worktreePath: "/repo/.aimux/worktrees/new" });
    const result = filterDashboardVisibleModel({
      hideOfflineAgents: true,
      sessions: [offline],
      services: [],
      worktreeGroups: [
        group({
          name: "new",
          branch: "(creating)",
          path: "/repo/.aimux/worktrees/new",
          pending: true,
          pendingAction: "creating",
          sessions: [offline],
        }),
      ],
    });

    expect(result.sessions).toEqual([]);
    expect(result.worktreeGroups).toHaveLength(1);
    expect(result.worktreeGroups[0].sessions).toEqual([]);
  });
});
