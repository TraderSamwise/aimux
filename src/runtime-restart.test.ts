import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupStaleDashboardLinks,
  isExitedProcessState,
  isRuntimeRestartInProgress,
  restartAimuxControlPlane,
  renderRuntimeRestartResult,
} from "./runtime-restart.js";
import type { RuntimeCoherenceReport } from "./runtime-coherence.js";

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

function coherenceReport(): RuntimeCoherenceReport {
  return {
    generatedAt: "2026-06-20T00:00:00.000Z",
    cliVersion: "0.1.21",
    cliLaunch: {
      command: "/Users/sam/.local/bin/aimux",
      args: [],
      source: "stable-shim",
      currentEntryPath: "/Users/sam/.aimux/native/current/dist/launcher-bin.js",
      stableShimPath: "/Users/sam/.local/bin/aimux",
    },
    expected: {
      projectService: { apiVersion: 4, capabilities: {}, buildStamp: "service-new" },
      runtimeOwner: "owner-new",
      runtimeContract: "1",
    },
    daemon: {
      running: true,
      info: { pid: 9001, port: 43190, startedAt: "then", updatedAt: "now" },
      process: null,
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
        runtime: {
          sessionName: "aimux-alpha-111",
          contract: "1",
          expectedContract: "1",
          rebuildRequired: false,
        },
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
          process: null,
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
            process: null,
            status: "mismatch",
          },
        ],
        status: "needs-restart",
      },
      {
        projectRoot: "/repo/beta",
        sources: ["daemon-state"],
        expectedDashboardBuildStamp: "dashboard-new",
        runtime: {
          sessionName: "aimux-beta-222",
          contract: "1",
          expectedContract: "1",
          rebuildRequired: false,
        },
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
          process: null,
          serviceInfo: { apiVersion: 4, capabilities: {}, buildStamp: "service-new" },
          error: null,
        },
        dashboards: [],
        status: "ok",
      },
    ],
    staleHookProcesses: [],
    summary: {
      projects: 2,
      ok: 1,
      needsRestart: 1,
      runtimeRebuildRequired: 0,
    },
  };
}

function okCoherenceReport(): RuntimeCoherenceReport {
  const report = coherenceReport();
  report.projects = report.projects.map((project) => ({
    ...project,
    status: "ok",
    service: {
      ...project.service,
      status: "ok",
      error: null,
    },
    dashboards: project.dashboards.map((dashboard) => ({
      ...dashboard,
      buildStamp: project.expectedDashboardBuildStamp,
      status: "ok",
    })),
  }));
  report.summary = {
    projects: report.projects.length,
    ok: report.projects.length,
    needsRestart: 0,
    runtimeRebuildRequired: 0,
  };
  return report;
}

function runtimeRebuildCoherenceReport(): RuntimeCoherenceReport {
  const report = okCoherenceReport();
  report.projects[0] = {
    ...report.projects[0]!,
    status: "needs-restart",
    runtime: {
      ...report.projects[0]!.runtime,
      contract: "legacy-contract",
      rebuildRequired: true,
    },
  };
  report.summary = {
    projects: report.projects.length,
    ok: report.projects.length - 1,
    needsRestart: 1,
    runtimeRebuildRequired: 1,
  };
  return report;
}

function clientRuntimeRebuildCoherenceReport(): RuntimeCoherenceReport {
  const report = okCoherenceReport();
  report.projects[0] = {
    ...report.projects[0]!,
    status: "needs-restart",
    runtime: {
      ...report.projects[0]!.runtime,
      rebuildRequired: true,
      clientSessions: [
        {
          sessionName: "aimux-alpha-111-client-deadbeef",
          contract: "legacy-contract",
          rebuildRequired: true,
        },
      ],
    },
  };
  report.summary = {
    projects: report.projects.length,
    ok: report.projects.length - 1,
    needsRestart: 1,
    runtimeRebuildRequired: 1,
  };
  return report;
}

function staleHookCoherenceReport(): RuntimeCoherenceReport {
  const report = okCoherenceReport();
  report.staleHookProcesses = [
    {
      pid: 77,
      argsPreview: "claude --settings command=/old/dist/main.js claude-hook stop --project /repo/alpha",
      pathHints: ["/old/dist/main.js"],
      staleNativePath: true,
      error: null,
      projectRoot: "/repo/alpha",
    },
  ];
  report.summary = {
    projects: report.projects.length,
    ok: report.projects.length,
    needsRestart: 0,
    runtimeRebuildRequired: 0,
  };
  return report;
}

function foreignDashboardCoherenceReport(): RuntimeCoherenceReport {
  const report = okCoherenceReport();
  report.expected.runtimeOwner = "owner-isolated";
  report.projects[0] = {
    ...report.projects[0]!,
    status: "needs-restart",
    runtime: {
      ...report.projects[0]!.runtime,
      rebuildRequired: false,
    },
    dashboards: report.projects[0]!.dashboards.map((dashboard) => ({
      ...dashboard,
      owner: "owner-stable",
      runtimeOwner: "owner-stable",
      status: "mismatch",
    })),
  };
  report.summary = {
    projects: report.projects.length,
    ok: 1,
    needsRestart: 1,
    runtimeRebuildRequired: 0,
  };
  return report;
}

function stoppedDaemon(
  stoppedProjectServices: NonNullable<RuntimeCoherenceReport["projects"][number]["service"]["daemonState"]>[] = [],
) {
  return { pid: 9001, port: 43190, startedAt: "then", updatedAt: "now", stoppedProjectServices };
}

describe("restartAimuxControlPlane", () => {
  let previousAimuxHome: string | undefined;
  let testAimuxHome: string | null = null;

  beforeEach(() => {
    previousAimuxHome = process.env.AIMUX_HOME;
    testAimuxHome = mkdtempSync(join(tmpdir(), "aimux-runtime-restart-"));
    process.env.AIMUX_HOME = testAimuxHome;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    execFileSyncMock.mockReset();
    if (previousAimuxHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previousAimuxHome;
    if (testAimuxHome) rmSync(testAimuxHome, { recursive: true, force: true });
    testAimuxHome = null;
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

  it("reports only fresh live restart locks as in progress", () => {
    const lockPath = join(testAimuxHome!, "locks", "restart");
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, "owner.json"), `${JSON.stringify({ pid: process.pid })}\n`);

    expect(isRuntimeRestartInProgress()).toBe(true);

    const old = new Date("2000-01-01T00:00:00.000Z");
    utimesSync(lockPath, old, old);

    expect(isRuntimeRestartInProgress()).toBe(false);
  });

  it("serializes concurrent control-plane restarts with a global lock", async () => {
    let releaseStopDaemon: ((value: ReturnType<typeof stoppedDaemon>) => void) | undefined;
    const stopDaemon = vi.fn(
      () =>
        new Promise<ReturnType<typeof stoppedDaemon>>((resolve) => {
          releaseStopDaemon = resolve;
        }),
    );
    const firstRestart = restartAimuxControlPlane({
      now: () => new Date("2026-06-20T00:00:01.000Z"),
      buildRuntimeCoherenceReport: vi.fn(async () => coherenceReport()),
      stopDaemon,
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
      isPidAlive: () => false,
    });
    await vi.waitFor(() => expect(stopDaemon).toHaveBeenCalled());

    await expect(
      restartAimuxControlPlane({
        buildRuntimeCoherenceReport: vi.fn(async () => coherenceReport()),
        stopDaemon: vi.fn(async () => stoppedDaemon()),
        ensureDaemonRunning: vi.fn(async () => ({ pid: 9003, port: 43190, startedAt: "after", updatedAt: "after" })),
        ensureProjectService: vi.fn(),
        createTmux: () => ({ isAvailable: () => true }),
      }),
    ).rejects.toThrow("aimux restart is already running");

    releaseStopDaemon?.(stoppedDaemon());
    await firstRestart;
  });

  it("keeps the global lock until an aborted in-process restart reaches a checkpoint", async () => {
    const abortController = new AbortController();
    let releaseStopDaemon: ((value: ReturnType<typeof stoppedDaemon>) => void) | undefined;
    const stopDaemon = vi.fn(
      () =>
        new Promise<ReturnType<typeof stoppedDaemon>>((resolve) => {
          releaseStopDaemon = resolve;
        }),
    );
    const firstRestart = restartAimuxControlPlane({
      now: () => new Date("2026-06-20T00:00:01.000Z"),
      buildRuntimeCoherenceReport: vi.fn(async () => coherenceReport()),
      stopDaemon,
      ensureDaemonRunning: vi.fn(async () => ({ pid: 9002, port: 43190, startedAt: "after", updatedAt: "after" })),
      ensureProjectService: vi.fn(),
      createTmux: () => ({ isAvailable: () => true }),
      isPidAlive: (pid) => pid === process.pid,
      abortSignal: abortController.signal,
    });
    const firstRestartError = firstRestart.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(stopDaemon).toHaveBeenCalled());

    abortController.abort();
    await expect(
      restartAimuxControlPlane({
        buildRuntimeCoherenceReport: vi.fn(async () => okCoherenceReport()),
        stopDaemon: vi.fn(async () => stoppedDaemon()),
        ensureDaemonRunning: vi.fn(async () => ({ pid: 9003, port: 43190, startedAt: "after", updatedAt: "after" })),
        ensureProjectService: vi.fn(),
        createTmux: () => ({ isAvailable: () => true }),
        isPidAlive: (pid) => pid === process.pid,
      }),
    ).rejects.toThrow("aimux restart is already running");

    releaseStopDaemon?.(stoppedDaemon());
    await expect(firstRestartError).resolves.toMatchObject({ message: "aimux restart aborted" });

    await expect(
      restartAimuxControlPlane({
        now: () => new Date("2026-06-20T00:00:02.000Z"),
        buildRuntimeCoherenceReport: vi.fn(async () => okCoherenceReport()),
        stopDaemon: vi.fn(async () => stoppedDaemon()),
        ensureDaemonRunning: vi.fn(async () => ({ pid: 9003, port: 43190, startedAt: "after", updatedAt: "after" })),
        ensureProjectService: vi.fn(),
        createTmux: () => ({ isAvailable: () => true }),
        isPidAlive: (pid) => pid === process.pid,
      }),
    ).resolves.toMatchObject({ daemon: { current: { pid: 9003 } } });
  });

  it("replaces stale restart locks even when the recorded owner is still alive", async () => {
    expect(testAimuxHome).toBeTruthy();
    const lockPath = join(testAimuxHome!, "locks", "restart");
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: 12345, acquiredAt: "2026-06-20T00:00:00.000Z" }));
    const old = new Date("2000-01-01T00:00:00.000Z");
    utimesSync(lockPath, old, old);

    const stopDaemon = vi.fn(async () => stoppedDaemon());
    await restartAimuxControlPlane({
      now: () => new Date("2026-06-20T00:00:01.000Z"),
      buildRuntimeCoherenceReport: vi.fn(async () => coherenceReport()),
      stopDaemon,
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
      isPidAlive: (pid) => pid === 12345,
    });

    expect(stopDaemon).toHaveBeenCalledOnce();
  });

  it("does not preempt fresh restart locks owned by dashboard repair", async () => {
    expect(testAimuxHome).toBeTruthy();
    const restartLockPath = join(testAimuxHome!, "locks", "restart");
    const repairLockPath = join(testAimuxHome!, "locks", "dashboard-control-plane-repair");
    mkdirSync(restartLockPath, { recursive: true });
    mkdirSync(repairLockPath, { recursive: true });
    writeFileSync(
      join(restartLockPath, "owner.json"),
      JSON.stringify({ pid: 12345, acquiredAt: "2026-06-20T00:00:00.000Z" }),
    );
    writeFileSync(
      join(repairLockPath, "owner.json"),
      JSON.stringify({ pid: 12345, projectRoot: "/repo/app", acquiredAt: "2026-06-20T00:00:00.000Z" }),
    );

    const stopDaemon = vi.fn(async () => stoppedDaemon());
    await expect(
      restartAimuxControlPlane({
        now: () => new Date("2026-06-20T00:00:01.000Z"),
        buildRuntimeCoherenceReport: vi.fn(async () => coherenceReport()),
        stopDaemon,
        ensureDaemonRunning: vi.fn(async () => ({ pid: 9002, port: 43190, startedAt: "after", updatedAt: "after" })),
        ensureProjectService: vi.fn(),
        createTmux: () => ({ isAvailable: () => true }),
        isPidAlive: (pid) => pid === 12345,
      }),
    ).rejects.toThrow("aimux restart is already running");

    expect(stopDaemon).not.toHaveBeenCalled();
    expect(existsSync(repairLockPath)).toBe(true);
  });

  it("does not release restart locks acquired by a newer owner", async () => {
    expect(testAimuxHome).toBeTruthy();
    const lockPath = join(testAimuxHome!, "locks", "restart");
    const stopDaemon = vi.fn(async () => {
      writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: 12345, acquiredAt: "after-steal" }));
      return stoppedDaemon();
    });

    await restartAimuxControlPlane({
      now: () => new Date("2026-06-20T00:00:01.000Z"),
      buildRuntimeCoherenceReport: vi.fn(async () => coherenceReport()),
      stopDaemon,
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
      isPidAlive: () => false,
    });

    expect(JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"))).toMatchObject({ pid: 12345 });
  });

  it("replaces stale restart locks when the recorded owner is gone", async () => {
    expect(testAimuxHome).toBeTruthy();
    const lockPath = join(testAimuxHome!, "locks", "restart");
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: 12345, acquiredAt: "2026-06-20T00:00:00.000Z" }));
    const old = new Date("2000-01-01T00:00:00.000Z");
    utimesSync(lockPath, old, old);

    const stopDaemon = vi.fn(async () => stoppedDaemon());
    await restartAimuxControlPlane({
      now: () => new Date("2026-06-20T00:00:01.000Z"),
      buildRuntimeCoherenceReport: vi.fn(async () => coherenceReport()),
      stopDaemon,
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
      isPidAlive: () => false,
    });

    expect(stopDaemon).toHaveBeenCalledOnce();
  });

  it("replaces fresh restart locks when the recorded owner is gone", async () => {
    expect(testAimuxHome).toBeTruthy();
    const lockPath = join(testAimuxHome!, "locks", "restart");
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: 12345, acquiredAt: "2026-06-20T00:00:00.000Z" }));

    const stopDaemon = vi.fn(async () => stoppedDaemon());
    await restartAimuxControlPlane({
      now: () => new Date("2026-06-20T00:00:01.000Z"),
      buildRuntimeCoherenceReport: vi.fn(async () => coherenceReport()),
      stopDaemon,
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
      isPidAlive: () => false,
    });

    expect(stopDaemon).toHaveBeenCalledOnce();
  });

  it("does not steal stale restart locks while another cleanup is in progress", async () => {
    expect(testAimuxHome).toBeTruthy();
    const lockPath = join(testAimuxHome!, "locks", "restart");
    const stealPath = join(testAimuxHome!, "locks", "restart.steal");
    mkdirSync(lockPath, { recursive: true });
    mkdirSync(stealPath, { recursive: true });
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: 12345, acquiredAt: "2026-06-20T00:00:00.000Z" }));
    const old = new Date("2000-01-01T00:00:00.000Z");
    utimesSync(lockPath, old, old);

    const stopDaemon = vi.fn(async () => stoppedDaemon());
    await expect(
      restartAimuxControlPlane({
        now: () => new Date("2026-06-20T00:00:01.000Z"),
        buildRuntimeCoherenceReport: vi.fn(async () => coherenceReport()),
        stopDaemon,
        ensureDaemonRunning: vi.fn(async () => ({ pid: 9002, port: 43190, startedAt: "after", updatedAt: "after" })),
        ensureProjectService: vi.fn(),
        createTmux: () => ({ isAvailable: () => true }),
        isPidAlive: () => false,
      }),
    ).rejects.toThrow("aimux restart is already running");

    expect(stopDaemon).not.toHaveBeenCalled();
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

  it("restarts the daemon, adopts a matching daemon if one wins the startup race, and reloads existing dashboards", async () => {
    const ensureProjectService = vi.fn(async (projectRoot: string) => ({
      projectId: projectRoot.endsWith("alpha") ? "alpha" : "beta",
      projectRoot,
      pid: projectRoot.endsWith("alpha") ? 1003 : 1004,
      startedAt: "after",
      updatedAt: "after",
    }));
    const ensureDaemonRunning = vi.fn(async () => ({ pid: 9002, port: 43190, startedAt: "after", updatedAt: "after" }));
    const stopProjectService = vi.fn(async (projectRoot: string) => ({
      projectId: projectRoot.endsWith("alpha") ? "alpha" : "beta",
      projectRoot,
      pid: projectRoot.endsWith("alpha") ? 1001 : 1002,
      startedAt: "before",
      updatedAt: "before",
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
      stopDaemon: vi.fn(async () => stoppedDaemon()),
      ensureDaemonRunning,
      ensureProjectService,
      stopProjectService,
      createTmux: () => ({ isAvailable: () => true }),
      resolveDashboardTarget,
      isPidAlive: () => false,
    });

    expect(result.summary).toEqual({
      projects: 2,
      servicesEnsured: 2,
      runtimeRepairs: 0,
      dashboardsReloaded: 1,
      runtimeRebuildRequired: 0,
      orphanProcessesCleaned: 0,
      orphanTmuxSessionsCleaned: 0,
      failures: 0,
    });
    expect(ensureDaemonRunning).toHaveBeenCalledWith();
    expect(stopProjectService).not.toHaveBeenCalled();
    expect(ensureProjectService).toHaveBeenCalledWith("/repo/alpha");
    expect(ensureProjectService).toHaveBeenCalledWith("/repo/beta");
    expect(resolveDashboardTarget).toHaveBeenCalledOnce();
    expect(resolveDashboardTarget).toHaveBeenCalledWith("/repo/alpha", expect.any(Object), {
      forceReload: true,
      openInHostSession: true,
    });
  });

  it("stops project services before ensuring them when retaining the daemon", async () => {
    const ensureProjectService = vi.fn(async (projectRoot: string) => ({
      projectId: projectRoot.endsWith("alpha") ? "alpha" : "beta",
      projectRoot,
      pid: projectRoot.endsWith("alpha") ? 1003 : 1004,
      startedAt: "after",
      updatedAt: "after",
    }));
    const stopProjectService = vi.fn(async (projectRoot: string) => ({
      projectId: projectRoot.endsWith("alpha") ? "alpha" : "beta",
      projectRoot,
      pid: projectRoot.endsWith("alpha") ? 1001 : 1002,
      startedAt: "before",
      updatedAt: "before",
    }));

    await restartAimuxControlPlane({
      buildRuntimeCoherenceReport: vi.fn(async () => coherenceReport()),
      stopDaemon: vi.fn(async () => null),
      ensureDaemonRunning: vi.fn(async () => ({ pid: 9001, port: 43190, startedAt: "then", updatedAt: "now" })),
      ensureProjectService,
      stopProjectService,
      createTmux: () => ({ isAvailable: () => false }),
      retainDaemon: true,
      isPidAlive: () => false,
    });

    expect(stopProjectService).toHaveBeenCalledWith("/repo/alpha");
    expect(stopProjectService).toHaveBeenCalledWith("/repo/beta");
    expect(stopProjectService.mock.invocationCallOrder[0]).toBeLessThan(
      ensureProjectService.mock.invocationCallOrder[0]!,
    );
    expect(stopProjectService.mock.invocationCallOrder[1]).toBeLessThan(
      ensureProjectService.mock.invocationCallOrder[1]!,
    );
  });

  it("recreates missing dashboards for tmux-backed projects during global restart", async () => {
    const report = coherenceReport();
    report.projects = report.projects.map((project) =>
      project.projectRoot === "/repo/alpha"
        ? {
            ...project,
            dashboards: [],
            status: "needs-restart",
          }
        : project,
    );
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
      buildRuntimeCoherenceReport: vi.fn(async () => report),
      stopDaemon: vi.fn(async () => stoppedDaemon()),
      ensureDaemonRunning: vi.fn(async () => ({ pid: 9002, port: 43190, startedAt: "after", updatedAt: "after" })),
      ensureProjectService: vi.fn(async (projectRoot: string) => ({
        projectId: projectRoot.endsWith("alpha") ? "alpha" : "beta",
        projectRoot,
        pid: projectRoot.endsWith("alpha") ? 1003 : 1004,
        startedAt: "after",
        updatedAt: "after",
      })),
      stopProjectService: vi.fn(async () => null),
      createTmux: () => ({ isAvailable: () => true }),
      resolveDashboardTarget,
      isPidAlive: () => false,
    });

    expect(result.projects.find((project) => project.projectRoot === "/repo/alpha")?.dashboard.status).toBe("reloaded");
    expect(resolveDashboardTarget).toHaveBeenCalledWith("/repo/alpha", expect.any(Object), {
      forceReload: true,
      openInHostSession: true,
    });
  });

  it("reloads stale dashboards owned by another runtime owner", async () => {
    const ensureProjectService = vi.fn(async (projectRoot: string) => ({
      projectId: projectRoot.endsWith("alpha") ? "alpha" : "beta",
      projectRoot,
      pid: projectRoot.endsWith("alpha") ? 1003 : 1004,
      startedAt: "after",
      updatedAt: "after",
    }));
    const resolveDashboardTarget = vi.fn(() => ({
      dashboardSession: { sessionName: "aimux-alpha-111" },
      dashboardTarget: { sessionName: "aimux-alpha-111", windowId: "@1", windowIndex: 0, windowName: "dashboard" },
    }));
    const setSessionOption = vi.fn();
    const report = foreignDashboardCoherenceReport();
    const after = okCoherenceReport();
    after.expected.runtimeOwner = report.expected.runtimeOwner;
    const buildRuntimeCoherenceReport = vi.fn().mockResolvedValueOnce(report).mockResolvedValueOnce(after);

    const result = await restartAimuxControlPlane({
      now: () => new Date("2026-06-20T00:00:01.000Z"),
      buildRuntimeCoherenceReport,
      verifyAfterRestart: true,
      verificationTimeoutMs: 0,
      stopDaemon: vi.fn(async () => stoppedDaemon()),
      ensureDaemonRunning: vi.fn(async () => ({ pid: 9002, port: 43190, startedAt: "after", updatedAt: "after" })),
      ensureProjectService,
      createTmux: () => ({
        isAvailable: () => true,
        getProjectSession: vi.fn((projectRoot: string) => ({
          sessionName: projectRoot.endsWith("alpha") ? "aimux-alpha-111" : "aimux-beta-222",
        })),
        getSessionOption: vi.fn((sessionName: string, key: string) =>
          sessionName === "aimux-alpha-111" && key === "@aimux-runtime-owner" ? "owner-stable" : null,
        ),
        setSessionOption,
      }),
      resolveDashboardTarget,
      isPidAlive: () => false,
    });

    expect(resolveDashboardTarget).toHaveBeenCalledWith("/repo/alpha", expect.any(Object), {
      forceReload: true,
      openInHostSession: true,
    });
    expect(setSessionOption).not.toHaveBeenCalledWith("aimux-alpha-111", expect.any(String), expect.any(String));
    expect(ensureProjectService).toHaveBeenCalledWith("/repo/alpha");
    expect(result.projects[0]?.runtime.status).toBe("skipped");
    expect(result.projects[0]?.dashboard.status).toBe("reloaded");
    expect(result.verification.status).toBe("ok");
    expect(result.summary).toMatchObject({ dashboardsReloaded: 1, failures: 0 });
  });

  it("removes stale duplicate dashboards from the host session during restart", async () => {
    const killWindow = vi.fn();
    const unlinkWindow = vi.fn(() => {
      throw new Error("window only linked to one session");
    });

    const result = await restartAimuxControlPlane({
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
      createTmux: () => ({
        isAvailable: () => true,
        getProjectSession: vi.fn(() => ({ sessionName: "aimux-alpha-111" })),
        listWindows: vi.fn(() => [
          { id: "@1", index: 0, name: "dashboard", active: true },
          { id: "@old", index: 1, name: "dashboard", active: false },
        ]),
        unlinkWindow,
        killWindow,
      }),
      resolveDashboardTarget: vi.fn(() => ({
        dashboardSession: { sessionName: "aimux-alpha-111" },
        dashboardTarget: { sessionName: "aimux-alpha-111", windowId: "@1", windowIndex: 0, windowName: "dashboard" },
      })),
      isPidAlive: () => false,
    });

    expect(result.projects[0]?.dashboard.status).toBe("reloaded");
    expect(killWindow).toHaveBeenCalledWith({
      sessionName: "aimux-alpha-111",
      windowId: "@old",
      windowIndex: 1,
      windowName: "dashboard",
    });
  });

  it("cleans stale duplicate dashboards from the resolved host session", async () => {
    const killWindow = vi.fn();
    const unlinkWindow = vi.fn(() => {
      throw new Error("window only linked to one session");
    });
    const listWindows = vi.fn((sessionName: string) =>
      sessionName === "resolved-host"
        ? [
            { id: "@1", index: 0, name: "dashboard", active: true },
            { id: "@old", index: 1, name: "dashboard", active: false },
          ]
        : [],
    );

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
      createTmux: () => ({
        isAvailable: () => true,
        getProjectSession: vi.fn(() => ({ sessionName: "derived-host" })),
        listWindows,
        unlinkWindow,
        killWindow,
      }),
      resolveDashboardTarget: vi.fn(() => ({
        dashboardSession: { sessionName: "resolved-host" },
        dashboardTarget: { sessionName: "resolved-host", windowId: "@1", windowIndex: 0, windowName: "dashboard" },
      })),
      isPidAlive: () => false,
    });

    expect(listWindows).toHaveBeenCalledWith("resolved-host");
    expect(killWindow).toHaveBeenCalledWith({
      sessionName: "resolved-host",
      windowId: "@old",
      windowIndex: 1,
      windowName: "dashboard",
    });
  });

  it("fails verification when a foreign-owned dashboard remains stale after restart", async () => {
    const report = foreignDashboardCoherenceReport();
    const buildRuntimeCoherenceReport = vi.fn().mockResolvedValueOnce(report).mockResolvedValueOnce(report);

    const result = await restartAimuxControlPlane({
      now: () => new Date("2026-06-20T00:00:01.000Z"),
      buildRuntimeCoherenceReport,
      verifyAfterRestart: true,
      verificationTimeoutMs: 0,
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
      isPidAlive: () => false,
    });

    expect(result.verification.status).toBe("failed");
    expect(result.verification.error).toContain("/repo/alpha");
    expect(result.summary.failures).toBe(1);
  });

  it("can repair the control plane without reloading or verifying dashboards", async () => {
    const before = coherenceReport();
    const after = coherenceReport();
    const buildRuntimeCoherenceReport = vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    const resolveDashboardTarget = vi.fn();

    const result = await restartAimuxControlPlane({
      now: () => new Date("2026-06-20T00:00:01.000Z"),
      buildRuntimeCoherenceReport,
      verifyAfterRestart: true,
      verificationTimeoutMs: 0,
      stopDaemon: vi.fn(async () => stoppedDaemon()),
      ensureDaemonRunning: vi.fn(async () => ({ pid: 9002, port: 43190, startedAt: "after", updatedAt: "after" })),
      ensureProjectService: vi.fn(async (projectRoot: string) => ({
        projectId: projectRoot.endsWith("alpha") ? "alpha" : "beta",
        projectRoot,
        pid: projectRoot.endsWith("alpha") ? 1003 : 1004,
        startedAt: "after",
        updatedAt: "after",
      })),
      stopProjectService: vi.fn(async () => null),
      createTmux: () => ({ isAvailable: () => true }),
      resolveDashboardTarget,
      isPidAlive: () => false,
      reloadDashboards: false,
      verifyDashboards: false,
    });

    expect(resolveDashboardTarget).not.toHaveBeenCalled();
    expect(result.projects.find((project) => project.projectRoot === "/repo/alpha")?.dashboard.status).toBe("skipped");
    expect(result.verification.status).toBe("ok");
    expect(result.summary.dashboardsReloaded).toBe(0);
    expect(result.summary.failures).toBe(0);
  });

  it("records and notifies restart repair diagnostics", async () => {
    const repairNotifier = {
      record: vi.fn(),
      notify: vi.fn(),
    };

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
      isPidAlive: () => false,
      repairNotifier,
    });

    expect(repairNotifier.record).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: "/repo/alpha",
        action: "control-plane-restart",
        status: "repaired",
      }),
    );
    expect(repairNotifier.record).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: "/repo/alpha",
        action: "dashboard-reload",
        status: "repaired",
      }),
    );
    expect(repairNotifier.notify).toHaveBeenCalledWith(
      "Aimux repaired itself",
      expect.stringContaining("repair steps"),
    );
  });

  it("cleans validation orphans before building the restart plan", async () => {
    const calls: string[] = [];
    const cleanupLifecycleValidationOrphans = vi.fn(async () => {
      calls.push("cleanup");
      return {
        processPids: [101, 202],
        tmuxSessions: ["aimux-aimux-lifecycle-validate21"],
        errors: [],
      };
    });
    const buildRuntimeCoherenceReport = vi.fn(async () => {
      calls.push("coherence");
      return okCoherenceReport();
    });
    const repairNotifier = {
      record: vi.fn(),
      notify: vi.fn(),
    };

    const result = await restartAimuxControlPlane({
      now: () => new Date("2026-06-20T00:00:01.000Z"),
      buildRuntimeCoherenceReport,
      cleanupLifecycleValidationOrphans,
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
      isPidAlive: () => false,
      reloadDashboards: false,
      verifyAfterRestart: false,
      repairNotifier,
    });

    expect(calls).toEqual(["cleanup", "coherence"]);
    expect(cleanupLifecycleValidationOrphans).toHaveBeenCalledWith({
      tmux: expect.objectContaining({ isAvailable: expect.any(Function) }),
    });
    expect(result.summary).toMatchObject({
      orphanProcessesCleaned: 2,
      orphanTmuxSessionsCleaned: 1,
      failures: 0,
    });
    expect(renderRuntimeRestartResult(result)).toContain("validation orphans: 2 processes, 1 tmux sessions");
    expect(repairNotifier.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "validation-orphan-cleanup",
        status: "repaired",
      }),
    );
    expect(repairNotifier.notify).toHaveBeenCalledWith(
      "Aimux repaired itself",
      expect.stringContaining("repair steps"),
    );
  });

  it("does not fail restart when repair diagnostics fail", async () => {
    const result = await restartAimuxControlPlane({
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
      isPidAlive: () => false,
      repairNotifier: {
        record: () => {
          throw new Error("disk full");
        },
        notify: () => {
          throw new Error("notifications denied");
        },
      },
    });

    expect(result.summary.failures).toBe(0);
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
    const killWindow = vi.fn();

    const result = await restartAimuxControlPlane({
      projectRoot: "/repo/beta",
      now: () => new Date("2026-06-20T00:00:01.000Z"),
      buildRuntimeCoherenceReport: vi.fn(async () => coherenceReport()),
      stopDaemon: vi.fn(async () => stoppedDaemon()),
      ensureDaemonRunning: vi.fn(async () => ({ pid: 9002, port: 43190, startedAt: "after", updatedAt: "after" })),
      ensureProjectService,
      createTmux: () => ({ isAvailable: () => true, hasWindow: () => true, killWindow }),
      resolveDashboardTarget,
      isPidAlive: () => false,
    });

    expect(result.projects.map((project) => project.projectRoot)).toEqual(["/repo/beta"]);
    expect(ensureProjectService).not.toHaveBeenCalledWith("/repo/alpha");
    expect(ensureProjectService).toHaveBeenCalledWith("/repo/beta");
    expect(resolveDashboardTarget).toHaveBeenCalledOnce();
    expect(resolveDashboardTarget).toHaveBeenCalledWith("/repo/beta", expect.any(Object), {
      forceReload: true,
      openInHostSession: true,
    });
    expect(result.projects[0]?.dashboard.status).toBe("reloaded");
    expect(killWindow).not.toHaveBeenCalled();
    expect(renderRuntimeRestartResult(result)).toContain("dashboards reloaded: 1");
  });

  it("scoped restart verification ignores unrelated stale projects", async () => {
    const buildRuntimeCoherenceReport = vi.fn(async () => coherenceReport());

    const result = await restartAimuxControlPlane({
      projectRoot: "/repo/beta",
      now: () => new Date("2026-06-20T00:00:01.000Z"),
      buildRuntimeCoherenceReport,
      verifyAfterRestart: true,
      verificationTimeoutMs: 0,
      stopDaemon: vi.fn(async () => stoppedDaemon()),
      ensureDaemonRunning: vi.fn(async () => ({ pid: 9002, port: 43190, startedAt: "after", updatedAt: "after" })),
      ensureProjectService: vi.fn(async (projectRoot: string) => ({
        projectId: projectRoot.endsWith("alpha") ? "alpha" : "beta",
        projectRoot,
        pid: projectRoot.endsWith("alpha") ? 1003 : 1004,
        startedAt: "after",
        updatedAt: "after",
      })),
      createTmux: () => ({ isAvailable: () => true, hasWindow: () => true, killWindow: vi.fn() }),
      resolveDashboardTarget: vi.fn(() => ({
        dashboardSession: { sessionName: "aimux-beta" },
        dashboardTarget: { sessionName: "aimux-beta", windowId: "@2", windowIndex: 0, windowName: "dashboard" },
      })),
      isPidAlive: () => false,
    });

    expect(buildRuntimeCoherenceReport).toHaveBeenCalledTimes(2);
    expect(result.verification.status).toBe("ok");
    expect(result.summary.failures).toBe(0);
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

  it("stops stale dashboard windows before stopping the daemon", async () => {
    const calls: string[] = [];
    const tmux = {
      isAvailable: () => true,
      hasWindow: vi.fn(() => true),
      killWindow: vi.fn((target) => {
        calls.push(`kill-dashboard:${target.windowId}`);
      }),
    };

    await restartAimuxControlPlane({
      now: () => new Date("2026-06-20T00:00:01.000Z"),
      buildRuntimeCoherenceReport: vi.fn(async () => coherenceReport()),
      stopDaemon: vi.fn(async () => {
        calls.push("stop-daemon");
        return stoppedDaemon();
      }),
      ensureDaemonRunning: vi.fn(async () => ({ pid: 9002, port: 43190, startedAt: "after", updatedAt: "after" })),
      ensureProjectService: vi.fn(async (projectRoot: string) => ({
        projectId: projectRoot.endsWith("alpha") ? "alpha" : "beta",
        projectRoot,
        pid: projectRoot.endsWith("alpha") ? 1003 : 1004,
        startedAt: "after",
        updatedAt: "after",
      })),
      createTmux: () => tmux,
      resolveDashboardTarget: vi.fn(() => ({
        dashboardSession: { sessionName: "aimux-alpha-111" },
        dashboardTarget: { sessionName: "aimux-alpha-111", windowId: "@10", windowIndex: 0, windowName: "dashboard" },
      })),
      isPidAlive: () => false,
    });

    expect(calls).toEqual(["kill-dashboard:@1", "stop-daemon"]);
    expect(tmux.killWindow).toHaveBeenCalledWith({
      sessionName: "aimux-alpha-111",
      windowId: "@1",
      windowIndex: 0,
      windowName: "dashboard",
    });
  });

  it("relinks recreated host dashboards into existing client sessions and restores active agents", async () => {
    const dashboardTarget = {
      sessionName: "aimux-alpha-111",
      windowId: "@10",
      windowIndex: 0,
      windowName: "dashboard",
    };
    const tmux = {
      isAvailable: () => true,
      hasWindow: vi.fn(() => true),
      killWindow: vi.fn(),
      getProjectSession: vi.fn(() => ({ sessionName: "aimux-alpha-111" })),
      listSessionNames: vi.fn(() => ["aimux-alpha-111", "aimux-alpha-111-client-deadbeef"]),
      listWindows: vi.fn((sessionName: string) =>
        sessionName.endsWith("client-deadbeef")
          ? [{ id: "@3", index: 1, name: "codex", active: true }]
          : [{ id: "@10", index: 0, name: "dashboard", active: true }],
      ),
      linkWindowToSession: vi.fn((_sessionName, target, windowIndex) => ({
        ...target,
        sessionName: "aimux-alpha-111-client-deadbeef",
        windowIndex: windowIndex ?? 2,
      })),
      selectWindow: vi.fn(),
    };

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
      createTmux: () => tmux,
      resolveDashboardTarget: vi.fn(() => ({
        dashboardSession: { sessionName: "aimux-alpha-111" },
        dashboardTarget,
      })),
      isPidAlive: () => false,
    });

    expect(tmux.linkWindowToSession).toHaveBeenCalledWith("aimux-alpha-111-client-deadbeef", dashboardTarget, 0);
    expect(tmux.selectWindow).toHaveBeenCalledWith({
      sessionName: "aimux-alpha-111-client-deadbeef",
      windowId: "@3",
      windowIndex: 1,
      windowName: "codex",
    });
  });

  it("normalizes already linked client dashboards back into the dashboard slot", async () => {
    const dashboardTarget = {
      sessionName: "aimux-alpha-111",
      windowId: "@10",
      windowIndex: 0,
      windowName: "dashboard",
    };
    const tmux = {
      isAvailable: () => true,
      hasWindow: vi.fn(() => true),
      killWindow: vi.fn(),
      getProjectSession: vi.fn(() => ({ sessionName: "aimux-alpha-111" })),
      listSessionNames: vi.fn(() => ["aimux-alpha-111", "aimux-alpha-111-client-deadbeef"]),
      listWindows: vi.fn((sessionName: string) =>
        sessionName.endsWith("client-deadbeef")
          ? [
              { id: "@stale", index: 0, name: "dashboard", active: true },
              { id: "@10", index: 1, name: "dashboard", active: false },
            ]
          : [{ id: "@10", index: 0, name: "dashboard", active: true }],
      ),
      linkWindowToSession: vi.fn((sessionName, target, windowIndex) => ({
        ...target,
        sessionName,
        windowIndex: windowIndex ?? 2,
      })),
      unlinkWindow: vi.fn(),
      selectWindow: vi.fn(),
    };

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
      createTmux: () => tmux,
      resolveDashboardTarget: vi.fn(() => ({
        dashboardSession: { sessionName: "aimux-alpha-111" },
        dashboardTarget,
      })),
      isPidAlive: () => false,
    });

    expect(tmux.linkWindowToSession).toHaveBeenCalledWith("aimux-alpha-111-client-deadbeef", dashboardTarget, 0);
    expect(tmux.listWindows).toHaveBeenCalledWith("aimux-alpha-111-client-deadbeef");
    expect(tmux.unlinkWindow).toHaveBeenCalledWith({
      sessionName: "aimux-alpha-111-client-deadbeef",
      windowId: "@stale",
      windowIndex: 0,
      windowName: "dashboard",
    });
  });

  it("removes stale duplicate dashboard links from client sessions", () => {
    const tmux = {
      listWindows: vi.fn(() => [
        { id: "@437", index: 0, name: "dashboard", active: true },
        { id: "@438", index: 1, name: "dashboard", active: false },
        { id: "@441", index: 2, name: "claude", active: false },
      ]),
      unlinkWindow: vi.fn(),
    };

    const errors = cleanupStaleDashboardLinks(tmux, "aimux-alpha-111-client-deadbeef", {
      sessionName: "aimux-alpha-111-client-deadbeef",
      windowId: "@437",
      windowIndex: 0,
      windowName: "dashboard",
    });

    expect(errors).toEqual([]);
    expect(tmux.unlinkWindow).toHaveBeenCalledExactlyOnceWith({
      sessionName: "aimux-alpha-111-client-deadbeef",
      windowId: "@438",
      windowIndex: 1,
      windowName: "dashboard",
    });
  });

  it("kills stale duplicate dashboards when tmux cannot unlink the only link", () => {
    const tmux = {
      listWindows: vi.fn(() => [
        { id: "@437", index: 0, name: "dashboard", active: true },
        { id: "@438", index: 1, name: "dashboard", active: false },
      ]),
      unlinkWindow: vi.fn(() => {
        throw new Error("window only linked to one session");
      }),
      killWindow: vi.fn(),
    };

    const errors = cleanupStaleDashboardLinks(tmux, "aimux-alpha-111-client-deadbeef", {
      sessionName: "aimux-alpha-111-client-deadbeef",
      windowId: "@437",
      windowIndex: 0,
      windowName: "dashboard",
    });

    expect(errors).toEqual([]);
    expect(tmux.killWindow).toHaveBeenCalledExactlyOnceWith({
      sessionName: "aimux-alpha-111-client-deadbeef",
      windowId: "@438",
      windowIndex: 1,
      windowName: "dashboard",
    });
  });

  it("fails dashboard relink without appending when slot zero relink fails", async () => {
    const dashboardTarget = {
      sessionName: "aimux-alpha-111",
      windowId: "@10",
      windowIndex: 0,
      windowName: "dashboard",
    };
    const tmux = {
      isAvailable: () => true,
      hasWindow: vi.fn(() => true),
      killWindow: vi.fn(),
      getProjectSession: vi.fn(() => ({ sessionName: "aimux-alpha-111" })),
      listSessionNames: vi.fn(() => ["aimux-alpha-111", "aimux-alpha-111-client-deadbeef"]),
      listWindows: vi.fn((sessionName: string) =>
        sessionName.endsWith("client-deadbeef")
          ? [
              { id: "@stale", index: 0, name: "dashboard", active: true },
              { id: "@10", index: 1, name: "dashboard", active: false },
            ]
          : [{ id: "@10", index: 0, name: "dashboard", active: true }],
      ),
      linkWindowToSession: vi.fn((sessionName, target, windowIndex) => {
        if (windowIndex === 0) throw new Error("move failed");
        return {
          ...target,
          sessionName,
          windowIndex: 1,
        };
      }),
      selectWindow: vi.fn(),
    };

    const result = await restartAimuxControlPlane({
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
      createTmux: () => tmux,
      resolveDashboardTarget: vi.fn(() => ({
        dashboardSession: { sessionName: "aimux-alpha-111" },
        dashboardTarget,
      })),
      isPidAlive: () => false,
    });

    expect(result.projects[0]?.dashboard.status).toBe("failed");
    expect(result.projects[0]?.dashboard.error).toContain("move failed");
    expect(tmux.linkWindowToSession).toHaveBeenCalledWith("aimux-alpha-111-client-deadbeef", dashboardTarget, 0);
    expect(tmux.linkWindowToSession).toHaveBeenCalledTimes(1);
  });

  it("restores active agents even when one client dashboard relink fails", async () => {
    const dashboardTarget = {
      sessionName: "aimux-alpha-111",
      windowId: "@10",
      windowIndex: 0,
      windowName: "dashboard",
    };
    const activeAgent = {
      sessionName: "aimux-alpha-111-client-bbbbbbbb",
      windowId: "@3",
      windowIndex: 1,
      windowName: "codex",
    };
    const tmux = {
      isAvailable: () => true,
      hasWindow: vi.fn((target) => target.windowId === activeAgent.windowId),
      getProjectSession: vi.fn(() => ({ sessionName: "aimux-alpha-111" })),
      listSessionNames: vi.fn(() => [
        "aimux-alpha-111",
        "aimux-alpha-111-client-aaaaaaaa",
        "aimux-alpha-111-client-bbbbbbbb",
      ]),
      listWindows: vi.fn((sessionName: string) => {
        if (sessionName.endsWith("client-bbbbbbbb")) {
          return [
            { id: activeAgent.windowId, index: activeAgent.windowIndex, name: activeAgent.windowName, active: true },
          ];
        }
        if (sessionName.endsWith("client-aaaaaaaa")) {
          return [{ id: "@stale", index: 0, name: "dashboard", active: true }];
        }
        return [{ id: "@10", index: 0, name: "dashboard", active: true }];
      }),
      linkWindowToSession: vi.fn((sessionName, target, windowIndex) => {
        if (sessionName.endsWith("client-aaaaaaaa")) throw new Error("stale client missing");
        return {
          ...target,
          sessionName,
          windowIndex: windowIndex ?? 2,
        };
      }),
      selectWindow: vi.fn(),
    };

    const result = await restartAimuxControlPlane({
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
      createTmux: () => tmux,
      resolveDashboardTarget: vi.fn(() => ({
        dashboardSession: { sessionName: "aimux-alpha-111" },
        dashboardTarget,
      })),
      isPidAlive: () => false,
    });

    expect(result.projects[0]?.dashboard.status).toBe("failed");
    expect(result.projects[0]?.dashboard.error).toContain("stale client missing");
    expect(tmux.selectWindow).toHaveBeenCalledWith(activeAgent);
  });

  it("ignores malformed client-session suffixes during dashboard relink and active-window restore", async () => {
    const dashboardTarget = {
      sessionName: "aimux-alpha-111",
      windowId: "@10",
      windowIndex: 0,
      windowName: "dashboard",
    };
    const tmux = {
      isAvailable: () => true,
      hasWindow: vi.fn(() => true),
      getProjectSession: vi.fn(() => ({ sessionName: "aimux-alpha-111" })),
      listSessionNames: vi.fn(() => ["aimux-alpha-111", "aimux-alpha-111-client-stale"]),
      listWindows: vi.fn((sessionName: string) =>
        sessionName.endsWith("client-stale")
          ? [{ id: "@stale", index: 1, name: "codex", active: true }]
          : [{ id: "@10", index: 0, name: "dashboard", active: true }],
      ),
      linkWindowToSession: vi.fn(),
      selectWindow: vi.fn(),
    };

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
      createTmux: () => tmux,
      resolveDashboardTarget: vi.fn(() => ({
        dashboardSession: { sessionName: "aimux-alpha-111" },
        dashboardTarget,
      })),
      isPidAlive: () => false,
    });

    expect(tmux.linkWindowToSession).not.toHaveBeenCalledWith(
      "aimux-alpha-111-client-stale",
      expect.anything(),
      expect.anything(),
    );
    expect(tmux.selectWindow).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: "aimux-alpha-111-client-stale" }),
    );
  });

  it("fails restart when post-restart coherence still needs restart", async () => {
    const after = coherenceReport();
    after.projects[0] = {
      ...after.projects[0]!,
      status: "needs-restart",
      service: {
        ...after.projects[0]!.service,
        status: "mismatch",
      },
    };
    const buildRuntimeCoherenceReport = vi.fn().mockResolvedValueOnce(coherenceReport()).mockResolvedValueOnce(after);

    const result = await restartAimuxControlPlane({
      now: () => new Date("2026-06-20T00:00:01.000Z"),
      buildRuntimeCoherenceReport,
      verifyAfterRestart: true,
      verificationTimeoutMs: 0,
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
      isPidAlive: () => false,
    });

    expect(buildRuntimeCoherenceReport).toHaveBeenCalledTimes(2);
    expect(result.verification.status).toBe("failed");
    expect(result.summary.failures).toBe(1);
    expect(renderRuntimeRestartResult(result)).toContain("Post-restart verification failed");
  });

  it("repairs runtime contract drift and clears the rebuild marker", async () => {
    const setSessionOption = vi.fn();
    const configureManagedSession = vi.fn();
    const tmux = {
      isAvailable: () => true,
      getProjectSession: vi.fn((projectRoot: string) => ({
        sessionName: projectRoot.endsWith("alpha") ? "aimux-alpha-111" : "aimux-beta-222",
      })),
      listSessionNames: vi.fn(() => ["aimux-alpha-111", "aimux-alpha-111-client-deadbeef", "aimux-beta-222"]),
      configureManagedSession,
      setSessionOption,
    };
    const buildRuntimeCoherenceReport = vi
      .fn()
      .mockResolvedValueOnce(runtimeRebuildCoherenceReport())
      .mockResolvedValueOnce(okCoherenceReport());

    const result = await restartAimuxControlPlane({
      now: () => new Date("2026-06-20T00:00:01.000Z"),
      buildRuntimeCoherenceReport,
      verifyAfterRestart: true,
      verificationTimeoutMs: 0,
      stopDaemon: vi.fn(async () => stoppedDaemon()),
      ensureDaemonRunning: vi.fn(async () => ({ pid: 9002, port: 43190, startedAt: "after", updatedAt: "after" })),
      ensureProjectService: vi.fn(async (projectRoot: string) => ({
        projectId: projectRoot.endsWith("alpha") ? "alpha" : "beta",
        projectRoot,
        pid: projectRoot.endsWith("alpha") ? 1003 : 1004,
        startedAt: "after",
        updatedAt: "after",
      })),
      createTmux: () => tmux,
      resolveDashboardTarget: vi.fn(() => ({
        dashboardSession: { sessionName: "aimux-alpha-111" },
        dashboardTarget: { sessionName: "aimux-alpha-111", windowId: "@1", windowIndex: 0, windowName: "dashboard" },
      })),
      isPidAlive: () => false,
    });

    expect(configureManagedSession).toHaveBeenCalledWith("aimux-alpha-111", "/repo/alpha");
    expect(configureManagedSession).toHaveBeenCalledWith("aimux-alpha-111-client-deadbeef", "/repo/alpha");
    expect(setSessionOption).toHaveBeenCalledWith("aimux-alpha-111", "@aimux-runtime-contract", "1");
    expect(setSessionOption).toHaveBeenCalledWith("aimux-alpha-111-client-deadbeef", "@aimux-runtime-contract", "1");
    expect(setSessionOption).toHaveBeenCalledWith("aimux-beta-222", "@aimux-runtime-rebuild-required", "0");
    expect(setSessionOption).toHaveBeenCalledWith("aimux-alpha-111", "@aimux-runtime-rebuild-required", "0");
    expect(setSessionOption).toHaveBeenCalledWith(
      "aimux-alpha-111-client-deadbeef",
      "@aimux-runtime-rebuild-required",
      "0",
    );
    expect(result.verification.status).toBe("ok");
    expect(result.summary).toMatchObject({ runtimeRepairs: 1, runtimeRebuildRequired: 1, failures: 0 });
    expect(result.projects[0]?.runtimeRebuildRequired).toBe(true);
    expect(result.projects[0]?.runtime.status).toBe("repaired");
    expect(renderRuntimeRestartResult(result)).toContain("Runtime repaired:");
  });

  it("repairs client runtime contract drift when the host contract is current", async () => {
    const setSessionOption = vi.fn();
    const configureManagedSession = vi.fn();
    const tmux = {
      isAvailable: () => true,
      getProjectSession: vi.fn((projectRoot: string) => ({
        sessionName: projectRoot.endsWith("alpha") ? "aimux-alpha-111" : "aimux-beta-222",
      })),
      listSessionNames: vi.fn(() => ["aimux-alpha-111", "aimux-alpha-111-client-deadbeef", "aimux-beta-222"]),
      configureManagedSession,
      setSessionOption,
    };
    const buildRuntimeCoherenceReport = vi
      .fn()
      .mockResolvedValueOnce(clientRuntimeRebuildCoherenceReport())
      .mockResolvedValueOnce(okCoherenceReport());

    const result = await restartAimuxControlPlane({
      now: () => new Date("2026-06-20T00:00:01.000Z"),
      buildRuntimeCoherenceReport,
      verifyAfterRestart: true,
      verificationTimeoutMs: 0,
      stopDaemon: vi.fn(async () => stoppedDaemon()),
      ensureDaemonRunning: vi.fn(async () => ({ pid: 9002, port: 43190, startedAt: "after", updatedAt: "after" })),
      ensureProjectService: vi.fn(async (projectRoot: string) => ({
        projectId: projectRoot.endsWith("alpha") ? "alpha" : "beta",
        projectRoot,
        pid: projectRoot.endsWith("alpha") ? 1003 : 1004,
        startedAt: "after",
        updatedAt: "after",
      })),
      createTmux: () => tmux,
      resolveDashboardTarget: vi.fn(() => ({
        dashboardSession: { sessionName: "aimux-alpha-111" },
        dashboardTarget: { sessionName: "aimux-alpha-111", windowId: "@1", windowIndex: 0, windowName: "dashboard" },
      })),
      isPidAlive: () => false,
    });

    expect(configureManagedSession).toHaveBeenCalledWith("aimux-alpha-111", "/repo/alpha");
    expect(configureManagedSession).toHaveBeenCalledWith("aimux-alpha-111-client-deadbeef", "/repo/alpha");
    expect(setSessionOption).toHaveBeenCalledWith("aimux-alpha-111-client-deadbeef", "@aimux-runtime-contract", "1");
    expect(result.summary).toMatchObject({ runtimeRepairs: 1, runtimeRebuildRequired: 1, failures: 0 });
    expect(result.projects[0]?.runtimeRebuildRequired).toBe(true);
    expect(result.projects[0]?.runtime.status).toBe("repaired");
  });

  it("fails verification when runtime contract drift remains after repair", async () => {
    const tmux = {
      isAvailable: () => true,
      getProjectSession: vi.fn((projectRoot: string) => ({
        sessionName: projectRoot.endsWith("alpha") ? "aimux-alpha-111" : "aimux-beta-222",
      })),
      configureManagedSession: vi.fn(),
      setSessionOption: vi.fn(),
    };
    const buildRuntimeCoherenceReport = vi
      .fn()
      .mockResolvedValueOnce(runtimeRebuildCoherenceReport())
      .mockResolvedValueOnce(runtimeRebuildCoherenceReport());

    const result = await restartAimuxControlPlane({
      now: () => new Date("2026-06-20T00:00:01.000Z"),
      buildRuntimeCoherenceReport,
      verifyAfterRestart: true,
      verificationTimeoutMs: 0,
      stopDaemon: vi.fn(async () => stoppedDaemon()),
      ensureDaemonRunning: vi.fn(async () => ({ pid: 9002, port: 43190, startedAt: "after", updatedAt: "after" })),
      ensureProjectService: vi.fn(async (projectRoot: string) => ({
        projectId: projectRoot.endsWith("alpha") ? "alpha" : "beta",
        projectRoot,
        pid: projectRoot.endsWith("alpha") ? 1003 : 1004,
        startedAt: "after",
        updatedAt: "after",
      })),
      createTmux: () => tmux,
      resolveDashboardTarget: vi.fn(() => ({
        dashboardSession: { sessionName: "aimux-alpha-111" },
        dashboardTarget: { sessionName: "aimux-alpha-111", windowId: "@1", windowIndex: 0, windowName: "dashboard" },
      })),
      isPidAlive: () => false,
    });

    expect(result.verification.status).toBe("failed");
    expect(result.summary.failures).toBe(1);
    expect(renderRuntimeRestartResult(result)).toContain("Post-restart verification failed");
  });

  it("fails verification when a requested project is missing after restart", async () => {
    const after = okCoherenceReport();
    after.projects = after.projects.filter((project) => project.projectRoot !== "/repo/alpha");
    after.summary = {
      projects: after.projects.length,
      ok: after.projects.length,
      needsRestart: 0,
      runtimeRebuildRequired: 0,
    };
    const buildRuntimeCoherenceReport = vi.fn().mockResolvedValueOnce(coherenceReport()).mockResolvedValueOnce(after);

    const result = await restartAimuxControlPlane({
      projectRoot: "/repo/alpha",
      now: () => new Date("2026-06-20T00:00:01.000Z"),
      buildRuntimeCoherenceReport,
      verifyAfterRestart: true,
      verificationTimeoutMs: 0,
      stopDaemon: vi.fn(async () => stoppedDaemon()),
      ensureDaemonRunning: vi.fn(async () => ({ pid: 9002, port: 43190, startedAt: "after", updatedAt: "after" })),
      ensureProjectService: vi.fn(async (projectRoot: string) => ({
        projectId: "alpha",
        projectRoot,
        pid: 1003,
        startedAt: "after",
        updatedAt: "after",
      })),
      createTmux: () => ({ isAvailable: () => true }),
      resolveDashboardTarget: vi.fn(() => ({
        dashboardSession: { sessionName: "aimux-alpha-111" },
        dashboardTarget: { sessionName: "aimux-alpha-111", windowId: "@1", windowIndex: 0, windowName: "dashboard" },
      })),
      isPidAlive: () => false,
    });

    expect(result.verification.status).toBe("failed");
    expect(result.verification.error).toContain("/repo/alpha");
    expect(result.summary.failures).toBe(1);
  });

  it("does not treat stale agent hook commands as a tmux runtime rebuild", async () => {
    const setSessionOption = vi.fn();
    const buildRuntimeCoherenceReport = vi.fn().mockResolvedValue(staleHookCoherenceReport());

    const result = await restartAimuxControlPlane({
      now: () => new Date("2026-06-20T00:00:01.000Z"),
      buildRuntimeCoherenceReport,
      verifyAfterRestart: false,
      stopDaemon: vi.fn(async () => stoppedDaemon()),
      ensureDaemonRunning: vi.fn(async () => ({ pid: 9002, port: 43190, startedAt: "after", updatedAt: "after" })),
      ensureProjectService: vi.fn(async (projectRoot: string) => ({
        projectId: projectRoot.endsWith("alpha") ? "alpha" : "beta",
        projectRoot,
        pid: projectRoot.endsWith("alpha") ? 1003 : 1004,
        startedAt: "after",
        updatedAt: "after",
      })),
      createTmux: () => ({
        isAvailable: () => true,
        getProjectSession: vi.fn((projectRoot: string) => ({
          sessionName: projectRoot.endsWith("alpha") ? "aimux-alpha-111" : "aimux-beta-222",
        })),
        setSessionOption,
      }),
      resolveDashboardTarget: vi.fn(() => ({
        dashboardSession: { sessionName: "aimux-alpha-111" },
        dashboardTarget: { sessionName: "aimux-alpha-111", windowId: "@1", windowIndex: 0, windowName: "dashboard" },
      })),
      isPidAlive: () => false,
    });

    expect(setSessionOption).toHaveBeenCalledWith("aimux-alpha-111", "@aimux-runtime-rebuild-required", "0");
    expect(setSessionOption).toHaveBeenCalledWith("aimux-beta-222", "@aimux-runtime-rebuild-required", "0");
    expect(result.summary.runtimeRebuildRequired).toBe(0);
    expect(result.summary.runtimeRepairs).toBe(0);
    expect(result.projects[0]?.runtimeRebuildRequired).toBe(false);
  });

  it("does not fail restart when best-effort runtime marker cleanup targets a stale tmux session", async () => {
    const result = await restartAimuxControlPlane({
      now: () => new Date("2026-06-20T00:00:01.000Z"),
      buildRuntimeCoherenceReport: vi.fn(async () => coherenceReport()),
      verifyAfterRestart: false,
      stopDaemon: vi.fn(async () => stoppedDaemon()),
      ensureDaemonRunning: vi.fn(async () => ({ pid: 9002, port: 43190, startedAt: "after", updatedAt: "after" })),
      ensureProjectService: vi.fn(async (projectRoot: string) => ({
        projectId: projectRoot.endsWith("alpha") ? "alpha" : "beta",
        projectRoot,
        pid: projectRoot.endsWith("alpha") ? 1003 : 1004,
        startedAt: "after",
        updatedAt: "after",
      })),
      createTmux: () => ({
        isAvailable: () => true,
        getProjectSession: vi.fn((projectRoot: string) => ({
          sessionName: projectRoot.endsWith("alpha") ? "aimux-alpha-111" : "aimux-beta-222",
        })),
        setSessionOption: vi.fn(() => {
          throw new Error("no such session");
        }),
      }),
      resolveDashboardTarget: vi.fn(() => ({
        dashboardSession: { sessionName: "aimux-alpha-111" },
        dashboardTarget: { sessionName: "aimux-alpha-111", windowId: "@1", windowIndex: 0, windowName: "dashboard" },
      })),
      isPidAlive: () => false,
      repairNotifier: null,
    });

    expect(result.summary.failures).toBe(0);
    expect(result.projects[0]?.runtime.status).toBe("skipped");
  });

  it("waits for post-restart services to become coherent before failing verification", async () => {
    const transient = okCoherenceReport();
    transient.projects[0] = {
      ...transient.projects[0]!,
      status: "needs-restart",
      service: {
        ...transient.projects[0]!.service,
        status: "unreachable",
        error: "request timed out after 1000ms",
      },
    };
    transient.summary = { projects: 2, ok: 1, needsRestart: 1, runtimeRebuildRequired: 0 };
    const buildRuntimeCoherenceReport = vi
      .fn()
      .mockResolvedValueOnce(coherenceReport())
      .mockResolvedValueOnce(transient)
      .mockResolvedValueOnce(okCoherenceReport());
    const sleep = vi.fn(async () => {});

    const result = await restartAimuxControlPlane({
      now: () => new Date("2026-06-20T00:00:01.000Z"),
      buildRuntimeCoherenceReport,
      verifyAfterRestart: true,
      verificationTimeoutMs: 1000,
      verificationIntervalMs: 250,
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
      isPidAlive: () => false,
      sleep,
    });

    expect(buildRuntimeCoherenceReport).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(250);
    expect(result.verification.status).toBe("ok");
    expect(result.summary.failures).toBe(0);
  });

  it("repairs unhealthy project services during post-restart verification", async () => {
    const transient = okCoherenceReport();
    transient.projects[0] = {
      ...transient.projects[0]!,
      status: "needs-restart",
      service: {
        ...transient.projects[0]!.service,
        status: "unreachable",
        endpoint: null,
        pid: 1003,
        error: "daemon state exists but project service endpoint is missing",
      },
    };
    transient.summary = { projects: 2, ok: 1, needsRestart: 1, runtimeRebuildRequired: 0 };
    const buildRuntimeCoherenceReport = vi
      .fn()
      .mockResolvedValueOnce(coherenceReport())
      .mockResolvedValueOnce(transient)
      .mockResolvedValueOnce(okCoherenceReport());
    const ensureProjectService = vi.fn(async (projectRoot: string) => ({
      projectId: projectRoot.endsWith("alpha") ? "alpha" : "beta",
      projectRoot,
      pid: projectRoot.endsWith("alpha") ? 1005 : 1004,
      startedAt: "after",
      updatedAt: "after",
    }));

    const result = await restartAimuxControlPlane({
      now: () => new Date("2026-06-20T00:00:01.000Z"),
      buildRuntimeCoherenceReport,
      verifyAfterRestart: true,
      verificationTimeoutMs: 1000,
      verificationIntervalMs: 250,
      stopDaemon: vi.fn(async () => stoppedDaemon()),
      ensureDaemonRunning: vi.fn(async () => ({ pid: 9002, port: 43190, startedAt: "after", updatedAt: "after" })),
      ensureProjectService,
      createTmux: () => ({ isAvailable: () => true }),
      resolveDashboardTarget: vi.fn(() => ({
        dashboardSession: { sessionName: "aimux-alpha-111" },
        dashboardTarget: { sessionName: "aimux-alpha-111", windowId: "@1", windowIndex: 0, windowName: "dashboard" },
      })),
      isPidAlive: () => false,
      sleep: vi.fn(async () => {}),
    });

    expect(ensureProjectService).toHaveBeenCalledWith("/repo/alpha");
    expect(ensureProjectService).toHaveBeenCalledTimes(3);
    expect(result.verification.status).toBe("ok");
    expect(result.summary.failures).toBe(0);
  });

  it("uses a startup-grace default for post-restart verification", async () => {
    const transient = okCoherenceReport();
    transient.projects[0] = {
      ...transient.projects[0]!,
      status: "needs-restart",
      service: {
        ...transient.projects[0]!.service,
        status: "unreachable",
        error: "metadata endpoint missing",
      },
    };
    transient.summary = { projects: 2, ok: 1, needsRestart: 1, runtimeRebuildRequired: 0 };
    const buildRuntimeCoherenceReport = vi
      .fn()
      .mockResolvedValueOnce(coherenceReport())
      .mockResolvedValueOnce(transient)
      .mockResolvedValueOnce(transient)
      .mockResolvedValueOnce(transient)
      .mockResolvedValueOnce(transient)
      .mockResolvedValueOnce(transient)
      .mockResolvedValueOnce(transient)
      .mockResolvedValueOnce(okCoherenceReport());
    const sleep = vi.fn(async () => {});

    const result = await restartAimuxControlPlane({
      now: () => new Date("2026-06-20T00:00:01.000Z"),
      buildRuntimeCoherenceReport,
      verifyAfterRestart: true,
      verificationIntervalMs: 1000,
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
      isPidAlive: () => false,
      sleep,
    });

    expect(buildRuntimeCoherenceReport).toHaveBeenCalledTimes(8);
    expect(sleep).toHaveBeenCalledTimes(6);
    expect(result.verification.status).toBe("ok");
    expect(result.summary.failures).toBe(0);
  });

  it("does not fail restart for a transient service ensure race when verification is healthy", async () => {
    const buildRuntimeCoherenceReport = vi
      .fn()
      .mockResolvedValueOnce(coherenceReport())
      .mockResolvedValueOnce(okCoherenceReport());

    const result = await restartAimuxControlPlane({
      now: () => new Date("2026-06-20T00:00:01.000Z"),
      buildRuntimeCoherenceReport,
      verifyAfterRestart: true,
      verificationTimeoutMs: 0,
      stopDaemon: vi.fn(async () => stoppedDaemon()),
      ensureDaemonRunning: vi.fn(async () => ({ pid: 9002, port: 43190, startedAt: "after", updatedAt: "after" })),
      ensureProjectService: vi.fn(async (projectRoot: string) => {
        if (projectRoot.endsWith("alpha")) throw new Error("project service exited before it became ready: pid 1003");
        return {
          projectId: "beta",
          projectRoot,
          pid: 1004,
          startedAt: "after",
          updatedAt: "after",
        };
      }),
      createTmux: () => ({ isAvailable: () => true }),
      resolveDashboardTarget: vi.fn(() => ({
        dashboardSession: { sessionName: "aimux-alpha-111" },
        dashboardTarget: { sessionName: "aimux-alpha-111", windowId: "@1", windowIndex: 0, windowName: "dashboard" },
      })),
      isPidAlive: () => false,
    });

    expect(result.verification.status).toBe("ok");
    expect(result.projects[0]?.service.status).toBe("ensured");
    expect(result.projects[0]?.service.error).toBeNull();
    expect(result.projects[0]?.service.state?.pid).toBe(1001);
    expect(result.summary).toMatchObject({ servicesEnsured: 2, failures: 0 });
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

  it("cleans up known service pids even when no daemon was stopped", async () => {
    const isPidAlive = vi.fn(() => false);
    const killPid = vi.fn();

    const result = await restartAimuxControlPlane({
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
      isAimuxProjectServiceProcess: vi.fn(() => true),
      killPid,
      retainDaemon: true,
    });

    expect(killPid).toHaveBeenCalledWith(1001, "SIGTERM");
    expect(killPid).toHaveBeenCalledWith(1002, "SIGTERM");
    expect(isPidAlive).toHaveBeenCalledWith(1001);
    expect(isPidAlive).toHaveBeenCalledWith(1002);
    expect(result.daemon.retained).toBe(true);
    expect(renderRuntimeRestartResult(result)).toContain("daemon: retained pid=9002");
  });

  it("cleans up legacy project service pids when cwd matches the pre-restart report", async () => {
    const isPidAlive = vi.fn(() => false);
    const killPid = vi.fn();
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "lsof") {
        const pid = Number(args[2]);
        return `p${pid}\nfcwd\nn${pid === 1001 ? "/repo/alpha" : "/repo/beta"}\n`;
      }
      return "node /opt/aimux/dist/main.js __project-service-internal";
    });

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

    expect(killPid).toHaveBeenCalledWith(1001, "SIGTERM");
    expect(killPid).toHaveBeenCalledWith(1002, "SIGTERM");
  });

  it("signals and waits service pids from the pre-restart report even when stopDaemon missed them", async () => {
    const calls: string[] = [];
    const isAimuxProjectServiceProcess = vi.fn(() => true);
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
      isAimuxProjectServiceProcess,
      killPid,
    });

    expect(isAimuxProjectServiceProcess).toHaveBeenCalledWith(1001, {
      pid: 1001,
      projectId: "alpha",
      projectRoot: "/repo/alpha",
    });
    expect(isAimuxProjectServiceProcess).toHaveBeenCalledWith(1002, {
      pid: 1002,
      projectId: "beta",
      projectRoot: "/repo/beta",
    });
    expect(isPidAlive).toHaveBeenCalledWith(9001);
    expect(killPid).toHaveBeenCalledWith(1001, "SIGTERM");
    expect(killPid).toHaveBeenCalledWith(1002, "SIGTERM");
    expect(calls.indexOf("kill:1001:SIGTERM")).toBeLessThan(calls.indexOf("pid:1001"));
    expect(calls.indexOf("kill:1002:SIGTERM")).toBeLessThan(calls.indexOf("pid:1002"));
  });

  it("does not signal or wait for unverified pre-restart service pids", async () => {
    const isPidAlive = vi.fn((pid: number) => pid === 1001 || pid === 1002);
    const killPid = vi.fn();

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
      isAimuxProjectServiceProcess: vi.fn(() => false),
      killPid,
    });

    expect(killPid).not.toHaveBeenCalledWith(1001, "SIGTERM");
    expect(killPid).not.toHaveBeenCalledWith(1002, "SIGTERM");
    expect(isPidAlive).toHaveBeenCalledWith(9001);
    expect(isPidAlive).not.toHaveBeenCalledWith(1001);
    expect(isPidAlive).not.toHaveBeenCalledWith(1002);
  });
});
