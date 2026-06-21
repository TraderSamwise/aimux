import { afterEach, describe, expect, it, vi } from "vitest";
import { isExitedProcessState, restartAimuxControlPlane, renderRuntimeRestartResult } from "./runtime-restart.js";
import type { RuntimeCoherenceReport } from "./runtime-coherence.js";

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

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
          daemonState: {
            projectId: "alpha",
            projectRoot: "/repo/alpha",
            pid: 1001,
            startedAt: "then",
            updatedAt: "now",
          },
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
          daemonState: {
            projectId: "beta",
            projectRoot: "/repo/beta",
            pid: 1002,
            startedAt: "then",
            updatedAt: "now",
          },
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

function stoppedDaemon(
  stoppedProjectServices: NonNullable<RuntimeCoherenceReport["projects"][number]["service"]["daemonState"]>[] = [],
) {
  return { pid: 9001, port: 43190, startedAt: "then", updatedAt: "now", stoppedProjectServices };
}

describe("restartAimuxControlPlane", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    execFileSyncMock.mockReset();
  });

  it("treats zombie ps states as exited", () => {
    expect(isExitedProcessState("Z")).toBe(true);
    expect(isExitedProcessState("Z+")).toBe(true);
    expect(isExitedProcessState("Zs")).toBe(true);
    expect(isExitedProcessState("S")).toBe(false);
    expect(isExitedProcessState("R+")).toBe(false);
  });

  it("treats zombie pids as exited through the default pid liveness check", async () => {
    const processKill = vi.spyOn(process, "kill").mockImplementation(() => true);
    execFileSyncMock.mockReturnValue("Z+");

    await restartAimuxControlPlane({
      now: () => new Date("2026-06-20T00:00:01.000Z"),
      buildRuntimeCoherenceReport: vi.fn(async () => coherenceReport()),
      stopDaemon: vi.fn(async () => stoppedDaemon()),
      ensureDaemonRunning: vi.fn(async () => ({ pid: 9002, port: 43190, startedAt: "after", updatedAt: "after" })),
      ensureProjectService: vi.fn(async (projectRoot: string) => ({
        projectId: projectRoot.endsWith("alpha") ? "alpha" : "beta",
        projectRoot,
        pid: projectRoot.endsWith("alpha") ? 1003 : 1004,
        startedAt: "after",
        updatedAt: "after",
      })),
      createTmux: () => ({ isAvailable: () => true }),
      resolveDashboardTarget: vi.fn(() => ({
        dashboardSession: { sessionName: "aimux-alpha-111" },
        dashboardTarget: { sessionName: "aimux-alpha-111", windowId: "@1", windowIndex: 0, windowName: "dashboard" },
      })),
    });

    expect(execFileSyncMock).toHaveBeenCalledWith("ps", ["-o", "stat=", "-p", "9001"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    expect(processKill).not.toHaveBeenCalledWith(9001, "SIGKILL");
  });

  it("treats live pids as alive when ps state probing fails", async () => {
    const processKill = vi.spyOn(process, "kill").mockImplementation(() => true);
    execFileSyncMock.mockImplementation(() => {
      throw new Error("ps unavailable");
    });

    await expect(
      restartAimuxControlPlane({
        now: () => new Date("2026-06-20T00:00:01.000Z"),
        buildRuntimeCoherenceReport: vi.fn(async () => coherenceReport()),
        stopDaemon: vi.fn(async () => stoppedDaemon()),
        ensureDaemonRunning: vi.fn(async () => ({ pid: 9002, port: 43190, startedAt: "after", updatedAt: "after" })),
        ensureProjectService: vi.fn(),
        createTmux: () => ({ isAvailable: () => true }),
        resolveDashboardTarget: vi.fn(),
        sleep: vi.fn(async () => {}),
        daemonExitTimeoutMs: 1,
        killGraceMs: 1,
      }),
    ).rejects.toThrow("pid 9001 did not exit within 2ms");
    expect(processKill).toHaveBeenCalledWith(9001, "SIGKILL");
  });

  it("treats pids as exited when they disappear during ps state probing", async () => {
    const processKill = vi
      .spyOn(process, "kill")
      .mockImplementationOnce(() => true)
      .mockImplementationOnce(() => {
        throw new Error("no such process");
      })
      .mockImplementation(() => true);
    execFileSyncMock.mockImplementation(() => {
      throw new Error("ps raced with exit");
    });

    await restartAimuxControlPlane({
      now: () => new Date("2026-06-20T00:00:01.000Z"),
      buildRuntimeCoherenceReport: vi.fn(async () => coherenceReport()),
      stopDaemon: vi.fn(async () => stoppedDaemon()),
      ensureDaemonRunning: vi.fn(async () => ({ pid: 9002, port: 43190, startedAt: "after", updatedAt: "after" })),
      ensureProjectService: vi.fn(async (projectRoot: string) => ({
        projectId: projectRoot.endsWith("alpha") ? "alpha" : "beta",
        projectRoot,
        pid: projectRoot.endsWith("alpha") ? 1003 : 1004,
        startedAt: "after",
        updatedAt: "after",
      })),
      isPidAlive: (pid) => {
        if (pid !== 9001) return false;
        try {
          processKill(pid, 0);
          return true;
        } catch {
          return false;
        }
      },
      createTmux: () => ({ isAvailable: () => true }),
      resolveDashboardTarget: vi.fn(() => ({
        dashboardSession: { sessionName: "aimux-alpha-111" },
        dashboardTarget: { sessionName: "aimux-alpha-111", windowId: "@1", windowIndex: 0, windowName: "dashboard" },
      })),
    });

    expect(processKill).toHaveBeenNthCalledWith(1, 9001, 0);
    expect(processKill).toHaveBeenNthCalledWith(2, 9001, 0);
    expect(processKill).not.toHaveBeenCalledWith(9001, "SIGKILL");
  });

  it("restarts the daemon, ensures known services, and reloads only existing dashboards by default", async () => {
    const ensureProjectService = vi.fn(async (projectRoot: string) => ({
      projectId: projectRoot.endsWith("alpha") ? "alpha" : "beta",
      projectRoot,
      pid: projectRoot.endsWith("alpha") ? 1003 : 1004,
      startedAt: "after",
      updatedAt: "after",
    }));
    const ensureDaemonRunning = vi.fn(async () => ({ pid: 9002, port: 43190, startedAt: "after", updatedAt: "after" }));
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
      stopDaemon: vi.fn(async () => stoppedDaemon()),
      ensureDaemonRunning,
      ensureProjectService,
      createTmux: () => ({ isAvailable: () => true }),
      resolveDashboardTarget,
      isPidAlive: () => false,
    });

    expect(result.summary).toEqual({ projects: 2, servicesEnsured: 2, dashboardsReloaded: 1, failures: 0 });
    expect(ensureDaemonRunning).toHaveBeenCalledWith({ adoptExisting: false });
    expect(ensureProjectService).toHaveBeenCalledWith("/repo/alpha");
    expect(ensureProjectService).toHaveBeenCalledWith("/repo/beta");
    expect(resolveDashboardTarget).toHaveBeenCalledOnce();
    expect(resolveDashboardTarget).toHaveBeenCalledWith("/repo/alpha", expect.any(Object), { forceReload: true });
  });

  it("scoped restart forces the scoped project service and dashboard", async () => {
    const ensureProjectService = vi.fn(async (projectRoot: string) => ({
      projectId: projectRoot.endsWith("alpha") ? "alpha" : "beta",
      projectRoot,
      pid: projectRoot.endsWith("alpha") ? 1003 : 1004,
      startedAt: "after",
      updatedAt: "after",
    }));
    const resolveDashboardTarget = vi.fn(() => ({
      dashboardSession: { sessionName: "aimux-beta" },
      dashboardTarget: { sessionName: "aimux-beta", windowId: "@2", windowIndex: 0, windowName: "dashboard" },
    }));

    const result = await restartAimuxControlPlane({
      projectRoot: "/repo/beta",
      now: () => new Date("2026-06-20T00:00:01.000Z"),
      buildRuntimeCoherenceReport: vi.fn(async () => coherenceReport()),
      stopDaemon: vi.fn(async () => stoppedDaemon()),
      ensureDaemonRunning: vi.fn(async () => ({ pid: 9002, port: 43190, startedAt: "after", updatedAt: "after" })),
      ensureProjectService,
      createTmux: () => ({ isAvailable: () => true }),
      resolveDashboardTarget,
      isPidAlive: () => false,
    });

    expect(result.projects.map((project) => project.projectRoot)).toEqual(["/repo/alpha", "/repo/beta"]);
    expect(ensureProjectService).toHaveBeenCalledWith("/repo/alpha");
    expect(ensureProjectService).toHaveBeenCalledWith("/repo/beta");
    expect(resolveDashboardTarget).toHaveBeenCalledOnce();
    expect(resolveDashboardTarget).toHaveBeenCalledWith("/repo/beta", expect.any(Object), { forceReload: true });
    expect(result.projects[0]?.dashboard.status).toBe("skipped");
    expect(result.projects[1]?.dashboard.status).toBe("reloaded");
    expect(renderRuntimeRestartResult(result)).toContain("dashboards reloaded: 1");
  });

  it("waits for the old daemon pid to exit before ensuring the new daemon", async () => {
    const calls: string[] = [];
    let aliveChecks = 0;
    await restartAimuxControlPlane({
      now: () => new Date("2026-06-20T00:00:01.000Z"),
      buildRuntimeCoherenceReport: vi.fn(async () => coherenceReport()),
      stopDaemon: vi.fn(async () => {
        calls.push("stop");
        return stoppedDaemon();
      }),
      ensureDaemonRunning: vi.fn(async () => {
        calls.push("ensure-daemon");
        return { pid: 9002, port: 43190, startedAt: "after", updatedAt: "after" };
      }),
      ensureProjectService: vi.fn(async (projectRoot: string) => ({
        projectId: projectRoot.endsWith("alpha") ? "alpha" : "beta",
        projectRoot,
        pid: projectRoot.endsWith("alpha") ? 1003 : 1004,
        startedAt: "after",
        updatedAt: "after",
      })),
      createTmux: () => ({ isAvailable: () => true }),
      resolveDashboardTarget: vi.fn(() => ({
        dashboardSession: { sessionName: "aimux-alpha-111" },
        dashboardTarget: { sessionName: "aimux-alpha-111", windowId: "@1", windowIndex: 0, windowName: "dashboard" },
      })),
      isPidAlive: vi.fn(() => ++aliveChecks < 2),
      sleep: vi.fn(async () => {
        calls.push("sleep");
      }),
      daemonExitTimeoutMs: 1000,
    });

    expect(calls).toEqual(["stop", "sleep", "ensure-daemon"]);
  });

  it("waits for old project service pids before ensuring services", async () => {
    const calls: string[] = [];
    const alive = new Map<number, number>([
      [1001, 1],
      [1002, 0],
      [9001, 0],
    ]);

    await restartAimuxControlPlane({
      now: () => new Date("2026-06-20T00:00:01.000Z"),
      buildRuntimeCoherenceReport: vi.fn(async () => coherenceReport()),
      stopDaemon: vi.fn(async () => {
        calls.push("stop");
        return stoppedDaemon(coherenceReport().projects.flatMap((project) => project.service.daemonState ?? []));
      }),
      ensureDaemonRunning: vi.fn(async () => {
        calls.push("ensure-daemon");
        return { pid: 9002, port: 43190, startedAt: "after", updatedAt: "after" };
      }),
      ensureProjectService: vi.fn(async (projectRoot: string) => {
        calls.push(`ensure-service:${projectRoot}`);
        return {
          projectId: projectRoot.endsWith("alpha") ? "alpha" : "beta",
          projectRoot,
          pid: projectRoot.endsWith("alpha") ? 1003 : 1004,
          startedAt: "after",
          updatedAt: "after",
        };
      }),
      createTmux: () => ({ isAvailable: () => true }),
      resolveDashboardTarget: vi.fn(() => ({
        dashboardSession: { sessionName: "aimux-alpha-111" },
        dashboardTarget: { sessionName: "aimux-alpha-111", windowId: "@1", windowIndex: 0, windowName: "dashboard" },
      })),
      isPidAlive: vi.fn((pid: number) => {
        const remaining = alive.get(pid) ?? 0;
        calls.push(`pid:${pid}:${remaining > 0 ? "alive" : "dead"}`);
        if (remaining > 0) alive.set(pid, remaining - 1);
        return remaining > 0;
      }),
      sleep: vi.fn(async () => {
        calls.push("sleep");
      }),
      serviceExitTimeoutMs: 1000,
    });

    expect(calls.indexOf("pid:1001:dead")).toBeLessThan(calls.indexOf("ensure-daemon"));
    expect(calls.indexOf("ensure-daemon")).toBeLessThan(calls.indexOf("ensure-service:/repo/alpha"));
  });

  it("does not wait or kill service pids when no daemon was stopped", async () => {
    const isPidAlive = vi.fn(() => {
      throw new Error("should not inspect service pids without a daemon stop");
    });
    const killPid = vi.fn();

    await restartAimuxControlPlane({
      now: () => new Date("2026-06-20T00:00:01.000Z"),
      buildRuntimeCoherenceReport: vi.fn(async () => coherenceReport()),
      stopDaemon: vi.fn(async () => null),
      ensureDaemonRunning: vi.fn(async () => ({ pid: 9002, port: 43190, startedAt: "after", updatedAt: "after" })),
      ensureProjectService: vi.fn(async (projectRoot: string) => ({
        projectId: projectRoot.endsWith("alpha") ? "alpha" : "beta",
        projectRoot,
        pid: projectRoot.endsWith("alpha") ? 1003 : 1004,
        startedAt: "after",
        updatedAt: "after",
      })),
      createTmux: () => ({ isAvailable: () => true }),
      resolveDashboardTarget: vi.fn(() => ({
        dashboardSession: { sessionName: "aimux-alpha-111" },
        dashboardTarget: { sessionName: "aimux-alpha-111", windowId: "@1", windowIndex: 0, windowName: "dashboard" },
      })),
      isPidAlive,
      killPid,
    });

    expect(isPidAlive).not.toHaveBeenCalled();
    expect(killPid).not.toHaveBeenCalled();
  });

  it("signals and waits service pids from the pre-restart report even when stopDaemon missed them", async () => {
    const calls: string[] = [];
    const isPidAlive = vi.fn((pid: number) => {
      calls.push(`pid:${pid}`);
      return false;
    });
    const killPid = vi.fn((pid: number, signal: NodeJS.Signals) => {
      calls.push(`kill:${pid}:${signal}`);
    });

    await restartAimuxControlPlane({
      now: () => new Date("2026-06-20T00:00:01.000Z"),
      buildRuntimeCoherenceReport: vi.fn(async () => coherenceReport()),
      stopDaemon: vi.fn(async () => stoppedDaemon([])),
      ensureDaemonRunning: vi.fn(async () => ({ pid: 9002, port: 43190, startedAt: "after", updatedAt: "after" })),
      ensureProjectService: vi.fn(async (projectRoot: string) => ({
        projectId: projectRoot.endsWith("alpha") ? "alpha" : "beta",
        projectRoot,
        pid: projectRoot.endsWith("alpha") ? 1003 : 1004,
        startedAt: "after",
        updatedAt: "after",
      })),
      createTmux: () => ({ isAvailable: () => true }),
      resolveDashboardTarget: vi.fn(() => ({
        dashboardSession: { sessionName: "aimux-alpha-111" },
        dashboardTarget: { sessionName: "aimux-alpha-111", windowId: "@1", windowIndex: 0, windowName: "dashboard" },
      })),
      isPidAlive,
      killPid,
    });

    expect(isPidAlive).toHaveBeenCalledWith(9001);
    expect(killPid).toHaveBeenCalledWith(1001, "SIGTERM");
    expect(killPid).toHaveBeenCalledWith(1002, "SIGTERM");
    expect(calls.indexOf("kill:1001:SIGTERM")).toBeLessThan(calls.indexOf("pid:1001"));
    expect(calls.indexOf("kill:1002:SIGTERM")).toBeLessThan(calls.indexOf("pid:1002"));
  });
});
