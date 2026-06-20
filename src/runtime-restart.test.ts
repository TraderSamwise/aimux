import { describe, expect, it, vi } from "vitest";
import { restartAimuxControlPlane, renderRuntimeRestartResult } from "./runtime-restart.js";
import type { RuntimeCoherenceReport } from "./runtime-coherence.js";

function coherenceReport(): RuntimeCoherenceReport {
  return {
    generatedAt: "2026-06-20T00:00:00.000Z",
    cliVersion: "0.1.21",
    expected: {
      projectService: { apiVersion: 4, capabilities: {}, buildStamp: "service-new" },
      runtimeOwner: "owner-new",
    },
    daemon: {
      running: true,
      info: { pid: 9001, port: 43190, startedAt: "then", updatedAt: "now" },
      projectCount: 2,
    },
    tmux: {
      available: true,
      version: "tmux 3.5a",
      sessionCount: 2,
    },
    projects: [
      {
        projectRoot: "/repo/alpha",
        sources: ["daemon-state", "tmux"],
        expectedDashboardBuildStamp: "dashboard-new",
        service: {
          status: "ok",
          daemonState: null,
          endpoint: null,
          pid: 1001,
          serviceInfo: { apiVersion: 4, capabilities: {}, buildStamp: "service-new" },
          error: null,
        },
        dashboards: [
          {
            sessionName: "aimux-alpha-111",
            windowId: "@1",
            windowIndex: 0,
            windowName: "dashboard",
            alive: true,
            buildStamp: "dashboard-old",
            owner: "owner-new",
            runtimeOwner: "owner-new",
            status: "mismatch",
          },
        ],
        status: "needs-restart",
      },
      {
        projectRoot: "/repo/beta",
        sources: ["daemon-state"],
        expectedDashboardBuildStamp: "dashboard-new",
        service: {
          status: "ok",
          daemonState: null,
          endpoint: null,
          pid: 1002,
          serviceInfo: { apiVersion: 4, capabilities: {}, buildStamp: "service-new" },
          error: null,
        },
        dashboards: [],
        status: "ok",
      },
    ],
    summary: {
      projects: 2,
      ok: 1,
      needsRestart: 1,
    },
  };
}

describe("restartAimuxControlPlane", () => {
  it("restarts the daemon, ensures known services, and reloads only existing dashboards by default", async () => {
    const ensureProjectService = vi.fn(async (projectRoot: string) => ({
      projectId: projectRoot.endsWith("alpha") ? "alpha" : "beta",
      projectRoot,
      pid: projectRoot.endsWith("alpha") ? 1003 : 1004,
      startedAt: "after",
      updatedAt: "after",
    }));
    const resolveDashboardTarget = vi.fn((projectRoot: string) => ({
      dashboardSession: { sessionName: projectRoot.endsWith("alpha") ? "aimux-alpha-111" : "aimux-beta-222" },
      dashboardTarget: {
        sessionName: projectRoot.endsWith("alpha") ? "aimux-alpha-111" : "aimux-beta-222",
        windowId: projectRoot.endsWith("alpha") ? "@1" : "@2",
        windowIndex: 0,
        windowName: "dashboard",
      },
    }));

    const result = await restartAimuxControlPlane({
      now: () => new Date("2026-06-20T00:00:01.000Z"),
      buildRuntimeCoherenceReport: vi.fn(async () => coherenceReport()),
      stopDaemon: vi.fn(async () => ({ pid: 9001, port: 43190, startedAt: "then", updatedAt: "now" })),
      ensureDaemonRunning: vi.fn(async () => ({ pid: 9002, port: 43190, startedAt: "after", updatedAt: "after" })),
      ensureProjectService,
      createTmux: () => ({ isAvailable: () => true }),
      resolveDashboardTarget,
    });

    expect(result.summary).toEqual({ projects: 2, servicesEnsured: 2, dashboardsReloaded: 1, failures: 0 });
    expect(ensureProjectService).toHaveBeenCalledWith("/repo/alpha");
    expect(ensureProjectService).toHaveBeenCalledWith("/repo/beta");
    expect(resolveDashboardTarget).toHaveBeenCalledOnce();
    expect(resolveDashboardTarget).toHaveBeenCalledWith("/repo/alpha", expect.any(Object), { forceReload: true });
  });

  it("scoped restart forces the scoped project service and dashboard", async () => {
    const result = await restartAimuxControlPlane({
      projectRoot: "/repo/beta",
      now: () => new Date("2026-06-20T00:00:01.000Z"),
      buildRuntimeCoherenceReport: vi.fn(async () => coherenceReport()),
      stopDaemon: vi.fn(async () => ({ pid: 9001, port: 43190, startedAt: "then", updatedAt: "now" })),
      ensureDaemonRunning: vi.fn(async () => ({ pid: 9002, port: 43190, startedAt: "after", updatedAt: "after" })),
      ensureProjectService: vi.fn(async () => ({
        projectId: "beta",
        projectRoot: "/repo/beta",
        pid: 1004,
        startedAt: "after",
        updatedAt: "after",
      })),
      createTmux: () => ({ isAvailable: () => true }),
      resolveDashboardTarget: vi.fn(() => ({
        dashboardSession: { sessionName: "aimux-beta" },
        dashboardTarget: { sessionName: "aimux-beta", windowId: "@2", windowIndex: 0, windowName: "dashboard" },
      })),
    });

    expect(result.projects.map((project) => project.projectRoot)).toEqual(["/repo/beta"]);
    expect(result.projects[0]?.service.status).toBe("ensured");
    expect(result.projects[0]?.dashboard.status).toBe("reloaded");
    expect(renderRuntimeRestartResult(result)).toContain("dashboards reloaded: 1");
  });
});
