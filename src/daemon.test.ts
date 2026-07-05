import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestJson } from "./http-client.js";
import { configureLogging, resetLoggingForTests } from "./debug.js";
import { getProjectServiceManifest } from "./project-service-manifest.js";
import { CORE_API_ROUTES, CORE_COMMAND_NAMES, type CoreCommandOk } from "./core-command-contract.js";
import { PROJECT_API_ROUTES } from "./project-api-contract.js";
import { getDaemonLogPath, getProjectIdFor, getProjectLogPathFor } from "./paths.js";

let tmpRoot = "";
let projectRoot = "";
let nextPid = 20_000;
let livePids = new Set<number>();
let childrenByPid = new Map<number, EventEmitter>();
const spawnMock = vi.fn();
const execFileSyncMock = vi.fn();
const STALE_SERVICE_TIMESTAMP = new Date(0).toISOString();
const coreActorMock = vi.hoisted(() => ({
  starts: vi.fn(),
  stops: vi.fn(),
  kills: vi.fn(),
  failStartFor: new Set<string>(),
  instances: [] as Array<{ projectRoot: string; running: boolean }>,
}));
const runtimeRestartMock = vi.hoisted(() => ({
  restartAimuxControlPlane: vi.fn(),
  renderRuntimeRestartResult: vi.fn(),
}));
const ensureProjectPathsMock = vi.hoisted(() => vi.fn());
const initPathsMock = vi.hoisted(() => vi.fn());
const loginFlowMock = vi.hoisted(() => vi.fn());
const runtimeCoherenceMock = vi.hoisted(() => ({
  buildRuntimeCoherenceReport: vi.fn(),
  renderRuntimeCoherenceReport: vi.fn(),
}));
const tmuxDoctorMock = vi.hoisted(() => ({
  buildTmuxDoctorReport: vi.fn(),
  renderTmuxDoctorReport: vi.fn(),
  repairTmuxRuntime: vi.fn(),
  renderTmuxRepairResult: vi.fn(),
}));
const backendReconcileMock = vi.hoisted(() => ({
  reconcileOfflineBackendSessionIds: vi.fn(),
}));
const dashboardTargetMock = vi.hoisted(() => ({
  resolveDashboardTarget: vi.fn(),
}));
const tmuxRuntimeMock = vi.hoisted(() => ({
  openTarget: vi.fn(),
  isInsideTmux: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

vi.mock("./paths.js", () => ({
  getGlobalAimuxDir: () => join(tmpRoot, ".aimux"),
  getDaemonInfoPath: () => join(tmpRoot, ".aimux", "daemon", "daemon.json"),
  getDaemonStatePath: () => join(tmpRoot, ".aimux", "daemon", "state.json"),
  getDaemonStdioLogPath: () => join(tmpRoot, ".aimux", "daemon", "logs", "daemon-stdio.log"),
  getDaemonLogPath: () => join(tmpRoot, ".aimux", "daemon", "logs", "daemon.jsonl"),
  getAuthPath: () => join(tmpRoot, ".aimux", "auth.json"),
  getProjectStateDir: () => join(tmpRoot, ".aimux", "projects", "global"),
  getProjectLogPath: () => join(tmpRoot, ".aimux", "projects", "global", "logs", "aimux.jsonl"),
  getProjectLogPathFor: (cwd: string) =>
    join(tmpRoot, ".aimux", "projects", `proj-${basename(cwd)}`, "logs", "aimux.jsonl"),
  getProjectStateDirFor: (cwd: string) => join(tmpRoot, ".aimux", "projects", `proj-${basename(cwd)}`),
  getProjectStateDirById: (projectId: string) => join(tmpRoot, ".aimux", "projects", projectId),
  getProjectIdFor: (cwd: string) => `proj-${basename(cwd)}`,
  ensureProjectPaths: ensureProjectPathsMock,
  initPaths: initPathsMock,
}));

vi.mock("./project-scanner.js", () => ({
  listDesktopProjects: () => listMockDesktopProjects(),
  listRegisteredDesktopProjects: () => listMockDesktopProjects(),
}));

vi.mock("./core-project-actor.js", () => ({
  CoreProjectActor: class {
    private running = false;
    private readonly projectRoot: string;
    private readonly projectId: string;
    private readonly startedAt = new Date().toISOString();

    constructor(projectRoot: string) {
      this.projectRoot = projectRoot;
      this.projectId = `proj-${basename(projectRoot)}`;
      coreActorMock.instances.push(this as unknown as { projectRoot: string; running: boolean });
    }

    getState() {
      return {
        projectId: this.projectId,
        projectRoot: this.projectRoot,
        pid: process.pid,
        startedAt: this.startedAt,
        updatedAt: new Date().toISOString(),
      };
    }

    isRunning() {
      return this.running;
    }

    async start() {
      coreActorMock.starts(this.projectRoot);
      if (coreActorMock.failStartFor.has(this.projectRoot)) {
        throw new Error("actor start failed");
      }
      this.running = true;
      return this.getState();
    }

    async stop() {
      this.running = false;
      coreActorMock.stops(this.projectRoot);
    }

    async kill() {
      this.running = false;
      coreActorMock.kills(this.projectRoot);
    }
  },
}));

vi.mock("./runtime-restart.js", () => ({
  restartAimuxControlPlane: runtimeRestartMock.restartAimuxControlPlane,
  renderRuntimeRestartResult: runtimeRestartMock.renderRuntimeRestartResult,
}));

vi.mock("./runtime-coherence.js", () => ({
  buildRuntimeCoherenceReport: runtimeCoherenceMock.buildRuntimeCoherenceReport,
  renderRuntimeCoherenceReport: runtimeCoherenceMock.renderRuntimeCoherenceReport,
}));

vi.mock("./tmux/doctor.js", () => ({
  buildTmuxDoctorReport: tmuxDoctorMock.buildTmuxDoctorReport,
  renderTmuxDoctorReport: tmuxDoctorMock.renderTmuxDoctorReport,
  repairTmuxRuntime: tmuxDoctorMock.repairTmuxRuntime,
  renderTmuxRepairResult: tmuxDoctorMock.renderTmuxRepairResult,
}));

vi.mock("./runtime-core/backend-id-reconcile.js", () => ({
  reconcileOfflineBackendSessionIds: backendReconcileMock.reconcileOfflineBackendSessionIds,
}));

vi.mock("./dashboard/targets.js", () => ({
  resolveDashboardTarget: dashboardTargetMock.resolveDashboardTarget,
}));

vi.mock("./tmux/runtime-manager.js", () => ({
  TmuxRuntimeManager: class {
    isInsideTmux() {
      return tmuxRuntimeMock.isInsideTmux();
    }

    openTarget(...args: unknown[]) {
      return tmuxRuntimeMock.openTarget(...args);
    }
  },
}));

vi.mock("./login-flow.js", () => ({
  runLoginFlow: loginFlowMock,
}));

function listMockDesktopProjects() {
  return [
    {
      id: `proj-${basename(projectRoot)}`,
      name: basename(projectRoot),
      path: projectRoot,
      dashboardSessionName: "aimux-test",
      sessions: [],
    },
  ];
}

vi.mock("./http-client.js", () => ({
  requestJson: vi.fn(async () => ({
    status: 200,
    json: { ok: true },
  })),
}));

function writeMetadataEndpointFor(pid: number, port = 44291) {
  mkdirSync(join(tmpRoot, ".aimux", "projects", `proj-${basename(projectRoot)}`), { recursive: true });
  writeFileSync(
    join(tmpRoot, ".aimux", "projects", `proj-${basename(projectRoot)}`, "metadata-api.json"),
    JSON.stringify({
      host: "127.0.0.1",
      port,
      pid,
      updatedAt: new Date().toISOString(),
    }),
  );
}

function daemonHealth(pid: number, port = 43190) {
  return {
    ok: true,
    kind: "aimux-daemon",
    pid,
    port,
    serviceInfo: getProjectServiceManifest(),
  };
}

function projectServiceHealth(pid: number, serviceInfo: unknown = getProjectServiceManifest()) {
  return {
    ok: true,
    pid,
    serviceInfo,
  };
}

function staleDaemonHealth(pid: number, port = 43190) {
  return {
    ...daemonHealth(pid, port),
    serviceInfo: { ...getProjectServiceManifest(), buildStamp: "stale-build" },
  };
}

function fakeRestartResult(current: unknown, failures = 0) {
  return {
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    before: { projects: [] },
    verification: { status: "skipped", after: null, error: null },
    daemon: { previous: null, current },
    projects: [],
    summary: {
      projects: 0,
      servicesEnsured: 0,
      runtimeRepairs: 0,
      dashboardsReloaded: 0,
      runtimeRebuildRequired: 0,
      failures,
    },
  };
}

function currentProjectServiceArgs(root: string): string {
  return `node /opt/aimux/dist/launcher-bin.js __project-service-internal --project-id ${getProjectIdFor(
    root,
  )} --project-root ${root}`;
}

function readMetadataEndpointPid(): number {
  const raw = readFileSync(
    join(tmpRoot, ".aimux", "projects", `proj-${basename(projectRoot)}`, "metadata-api.json"),
    "utf-8",
  );
  return JSON.parse(raw).pid as number;
}

async function listenOnLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind to a port");
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function mockProjectServiceHealth(
  responseForPid: (pid: number) => { status: number; json: unknown } | Promise<{ status: number; json: unknown }>,
) {
  vi.mocked(requestJson).mockImplementation(async (url: string) => {
    if (url.includes("44291")) {
      return responseForPid(readMetadataEndpointPid());
    }
    return {
      status: 200,
      json: daemonHealth(20_000),
    };
  });
}

function mockHealthyRequests() {
  mockProjectServiceHealth((pid) => ({
    status: 200,
    json: projectServiceHealth(pid),
  }));
}

describe("daemon supervision", () => {
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "aimux-daemon-"));
    projectRoot = join(tmpRoot, "repo");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(join(tmpRoot, ".aimux", "daemon"), { recursive: true });
    nextPid = 20_000;
    livePids = new Set<number>();
    childrenByPid = new Map<number, EventEmitter>();
    resetLoggingForTests();
    spawnMock.mockReset();
    coreActorMock.starts.mockReset();
    coreActorMock.stops.mockReset();
    coreActorMock.kills.mockReset();
    coreActorMock.failStartFor.clear();
    coreActorMock.instances.length = 0;
    runtimeRestartMock.restartAimuxControlPlane.mockReset();
    runtimeRestartMock.renderRuntimeRestartResult.mockReset();
    runtimeRestartMock.renderRuntimeRestartResult.mockReturnValue("Aimux Restart\n  failures: 0");
    ensureProjectPathsMock.mockReset();
    initPathsMock.mockReset();
    initPathsMock.mockResolvedValue(undefined);
    runtimeCoherenceMock.buildRuntimeCoherenceReport.mockReset();
    runtimeCoherenceMock.renderRuntimeCoherenceReport.mockReset();
    runtimeCoherenceMock.buildRuntimeCoherenceReport.mockResolvedValue({
      generatedAt: "now",
      projects: [],
      summary: { projects: 0 },
    });
    runtimeCoherenceMock.renderRuntimeCoherenceReport.mockReturnValue("Runtime Coherence\n  ok");
    tmuxDoctorMock.buildTmuxDoctorReport.mockReset();
    tmuxDoctorMock.renderTmuxDoctorReport.mockReset();
    tmuxDoctorMock.repairTmuxRuntime.mockReset();
    tmuxDoctorMock.renderTmuxRepairResult.mockReset();
    tmuxDoctorMock.buildTmuxDoctorReport.mockReturnValue({
      projectRoot,
      sessionName: "aimux-test",
      tmux: { available: true },
    });
    tmuxDoctorMock.renderTmuxDoctorReport.mockReturnValue("Tmux Doctor\n  ok");
    tmuxDoctorMock.repairTmuxRuntime.mockReturnValue({
      projectRoot,
      sessionName: "aimux-test",
      repairedSessions: ["aimux-test"],
      repairedWindows: ["@1"],
      dashboardWindowId: "@2",
      dashboardSessionName: "aimux-test",
    });
    tmuxDoctorMock.renderTmuxRepairResult.mockReturnValue("Tmux Repair\n  ok");
    backendReconcileMock.reconcileOfflineBackendSessionIds.mockReset();
    backendReconcileMock.reconcileOfflineBackendSessionIds.mockReturnValue({ reconciled: [] });
    dashboardTargetMock.resolveDashboardTarget.mockReset();
    dashboardTargetMock.resolveDashboardTarget.mockReturnValue({
      dashboardSession: { sessionName: "aimux-test" },
      dashboardTarget: { sessionName: "aimux-test", windowId: "@2", windowIndex: 0, windowName: "dashboard" },
    });
    tmuxRuntimeMock.openTarget.mockReset();
    tmuxRuntimeMock.isInsideTmux.mockReset();
    tmuxRuntimeMock.isInsideTmux.mockReturnValue(false);
    loginFlowMock.mockReset();
    loginFlowMock.mockResolvedValue({ userId: "user_123" });
    execFileSyncMock.mockReset();
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "lsof") return `p${args[2]}\nfcwd\nn${projectRoot}\n`;
      return currentProjectServiceArgs(projectRoot);
    });
    vi.mocked(requestJson).mockReset();
    mockHealthyRequests();
    spawnMock.mockImplementation((_command: string, args: string[] = []) => {
      const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
      child.pid = nextPid++;
      child.unref = () => {};
      livePids.add(child.pid);
      childrenByPid.set(child.pid, child);
      if (args.includes("__project-service-internal")) {
        mkdirSync(join(tmpRoot, ".aimux", "projects", `proj-${basename(projectRoot)}`), { recursive: true });
        writeMetadataEndpointFor(child.pid);
      }
      return child;
    });
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
      const numericPid = Number(pid);
      if (!livePids.has(numericPid)) {
        throw new Error(`pid ${numericPid} is not alive`);
      }
      if (signal && signal !== 0) {
        livePids.delete(numericPid);
        childrenByPid.get(numericPid)?.emit("exit", 0, signal);
      }
      return true;
    }) as typeof process.kill);
  });

  afterEach(() => {
    resetLoggingForTests();
    vi.restoreAllMocks();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("reuses a live project service instead of spawning a replacement", async () => {
    const { AimuxDaemon } = await import("./daemon.js");

    const daemon = new AimuxDaemon();
    const first = await (daemon as any).ensureProject(projectRoot);
    mkdirSync(join(tmpRoot, ".aimux", "projects", `proj-${basename(projectRoot)}`), { recursive: true });
    writeMetadataEndpointFor(first.pid);
    const second = await (daemon as any).ensureProject(projectRoot);

    expect(first.pid).toBe(second.pid);
    expect(first.pid).toBe(process.pid);
    expect(coreActorMock.starts).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("ensures project actors through the core command bus", async () => {
    const { AimuxDaemon } = await import("./daemon.js");

    const daemon = new AimuxDaemon();
    const response = await daemon.routeRequest("POST", CORE_API_ROUTES.commands, {
      id: "ensure-project",
      command: CORE_COMMAND_NAMES.projectEnsure,
      payload: { projectRoot },
    });
    const body = response.body as CoreCommandOk<typeof CORE_COMMAND_NAMES.projectEnsure>;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.result.project.projectRoot).toBe(projectRoot);
    expect(body.result.project.pid).toBe(process.pid);
    expect(coreActorMock.starts).toHaveBeenCalledWith(projectRoot);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("stops project actors through the core command bus", async () => {
    const { AimuxDaemon } = await import("./daemon.js");

    const daemon = new AimuxDaemon();
    await daemon.routeRequest("POST", CORE_API_ROUTES.commands, {
      command: CORE_COMMAND_NAMES.projectEnsure,
      payload: { projectRoot },
    });
    const response = await daemon.routeRequest("POST", CORE_API_ROUTES.commands, {
      id: "stop-project",
      command: CORE_COMMAND_NAMES.projectStop,
      payload: { projectRoot },
    });
    const body = response.body as CoreCommandOk<typeof CORE_COMMAND_NAMES.projectStop>;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.result.project?.projectRoot).toBe(projectRoot);
    expect(coreActorMock.stops).toHaveBeenCalledWith(projectRoot);
    expect(coreActorMock.kills).not.toHaveBeenCalled();
  });

  it("kills project actors through the core command bus", async () => {
    const { AimuxDaemon } = await import("./daemon.js");

    const daemon = new AimuxDaemon();
    await daemon.routeRequest("POST", CORE_API_ROUTES.commands, {
      command: CORE_COMMAND_NAMES.projectEnsure,
      payload: { projectRoot },
    });
    const response = await daemon.routeRequest("POST", CORE_API_ROUTES.commands, {
      id: "kill-project",
      command: CORE_COMMAND_NAMES.projectKill,
      payload: { projectRoot },
    });
    const body = response.body as CoreCommandOk<typeof CORE_COMMAND_NAMES.projectKill>;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.result.project?.projectRoot).toBe(projectRoot);
    expect(coreActorMock.kills).toHaveBeenCalledWith(projectRoot);
    expect(coreActorMock.stops).not.toHaveBeenCalled();
  });

  it("restarts project actors through the core command bus", async () => {
    const { AimuxDaemon } = await import("./daemon.js");

    const daemon = new AimuxDaemon();
    await daemon.routeRequest("POST", CORE_API_ROUTES.commands, {
      command: CORE_COMMAND_NAMES.projectEnsure,
      payload: { projectRoot },
    });
    const response = await daemon.routeRequest("POST", CORE_API_ROUTES.commands, {
      id: "restart-project",
      command: CORE_COMMAND_NAMES.projectRestart,
      payload: { projectRoot, open: true },
    });
    const body = response.body as CoreCommandOk<typeof CORE_COMMAND_NAMES.projectRestart>;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.result.project.projectRoot).toBe(projectRoot);
    expect(body.result.dashboardSessionName).toBe("aimux-test");
    expect(body.result.dashboardTarget).toEqual({
      sessionName: "aimux-test",
      windowId: "@2",
      windowIndex: 0,
      windowName: "dashboard",
    });
    expect(coreActorMock.stops).toHaveBeenCalledWith(projectRoot);
    expect(coreActorMock.starts).toHaveBeenCalledWith(projectRoot);
    expect(tmuxRuntimeMock.openTarget).not.toHaveBeenCalled();
  });

  it("runs control-plane restart through daemon-owned project actors", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    runtimeRestartMock.restartAimuxControlPlane.mockImplementationOnce(async (options: any) => {
      expect(await options.stopDaemon()).toBeNull();
      expect(options.isAimuxProjectServiceProcess(41_000, { projectRoot })).toBe(true);
      const current = await options.ensureDaemonRunning();
      await options.ensureProjectService(projectRoot);
      await options.stopProjectService(projectRoot);
      return fakeRestartResult(current);
    });

    const response = await daemon.routeRequest("POST", CORE_API_ROUTES.commands, {
      id: "restart-control-plane",
      command: CORE_COMMAND_NAMES.restart,
      payload: { projectRoot },
    });
    const body = response.body as CoreCommandOk<typeof CORE_COMMAND_NAMES.restart>;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.result.text).toBe("Aimux Restart\n  failures: 0");
    expect(body.result.restart.daemon.current.pid).toBe(process.pid);
    expect(runtimeRestartMock.restartAimuxControlPlane).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot,
        stopDaemon: expect.any(Function),
        ensureDaemonRunning: expect.any(Function),
        retainDaemon: true,
      }),
    );
    expect(coreActorMock.starts).toHaveBeenCalledWith(projectRoot);
    expect(coreActorMock.stops).toHaveBeenCalledWith(projectRoot);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("serves restart text for the installed shell shim", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    runtimeRestartMock.restartAimuxControlPlane.mockResolvedValueOnce(fakeRestartResult({ pid: process.pid }));

    const response = await daemon.routeRequest("POST", CORE_API_ROUTES.restartText);

    expect(response.status).toBe(200);
    expect(response.contentType).toBe("text/plain; charset=utf-8");
    expect(response.body).toBe("Aimux Restart\n  failures: 0\n");
  });

  it("returns a failing status for restart text when repair fails", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    runtimeRestartMock.restartAimuxControlPlane.mockResolvedValueOnce(fakeRestartResult({ pid: process.pid }, 1));
    runtimeRestartMock.renderRuntimeRestartResult.mockReturnValueOnce("Aimux Restart\n  failures: 1");

    const response = await daemon.routeRequest("POST", CORE_API_ROUTES.restartText);

    expect(response.status).toBe(500);
    expect(response.body).toBe("Aimux Restart\n  failures: 1\n");
  });

  it("keeps restart text errors as text/plain for the installed shell shim", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    runtimeRestartMock.restartAimuxControlPlane.mockRejectedValueOnce(new Error("aimux restart is already running"));

    const response = await daemon.routeRequest("POST", CORE_API_ROUTES.restartText);

    expect(response.status).toBe(500);
    expect(response.contentType).toBe("text/plain; charset=utf-8");
    expect(response.body).toBe("aimux restart is already running\n");
  });

  it("serves daemon-owned doctor versions text and JSON routes", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();

    const text = await daemon.routeRequest("GET", CORE_API_ROUTES.doctorVersionsText);
    const json = await daemon.routeRequest("GET", `${CORE_API_ROUTES.doctorVersionsText}?json=1`);

    expect(text).toMatchObject({
      status: 200,
      contentType: "text/plain; charset=utf-8",
      body: "Runtime Coherence\n  ok\n",
    });
    expect(JSON.parse(json.body as string)).toEqual({
      generatedAt: "now",
      projects: [],
      summary: { projects: 0 },
    });
    expect(runtimeCoherenceMock.buildRuntimeCoherenceReport).toHaveBeenCalledTimes(2);
  });

  it("serves daemon-owned tmux doctor routes with explicit project context", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();

    const response = await daemon.routeRequest(
      "GET",
      `${CORE_API_ROUTES.doctorTmuxText}?projectRoot=${encodeURIComponent(
        projectRoot,
      )}&session=aimux-test&windowId=%401`,
    );

    expect(response).toMatchObject({
      status: 200,
      contentType: "text/plain; charset=utf-8",
      body: "Tmux Doctor\n  ok\n",
    });
    expect(initPathsMock).toHaveBeenCalledWith(projectRoot);
    expect(tmuxDoctorMock.buildTmuxDoctorReport).toHaveBeenCalledWith(expect.anything(), {
      projectRoot,
      sessionName: "aimux-test",
      windowId: "@1",
    });
  });

  it("serves daemon-owned repair route and focuses tmux when requested", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();

    const response = await daemon.routeRequest(
      "POST",
      `${CORE_API_ROUTES.repairText}?projectRoot=${encodeURIComponent(projectRoot)}&open=1`,
    );

    expect(response).toMatchObject({
      status: 200,
      contentType: "text/plain; charset=utf-8",
      body: "Tmux Repair\n  ok\n",
    });
    expect(initPathsMock).toHaveBeenCalledWith(projectRoot);
    expect(coreActorMock.starts).toHaveBeenCalledWith(projectRoot);
    expect(tmuxDoctorMock.repairTmuxRuntime).toHaveBeenCalledWith(expect.anything(), { projectRoot });
    expect(tmuxRuntimeMock.openTarget).toHaveBeenCalledWith(
      { sessionName: "aimux-test", windowId: "@2", windowIndex: 0, windowName: "dashboard" },
      { insideTmux: false, alreadyResolved: true },
    );
  });

  it("serves repair route form bodies from the installed shell shim", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();

    const response = await daemon.routeRequest("POST", CORE_API_ROUTES.repairText, {
      projectRoot,
      open: "1",
    });

    expect(response).toMatchObject({ status: 200, body: "Tmux Repair\n  ok\n" });
    expect(coreActorMock.starts).toHaveBeenCalledWith(projectRoot);
    expect(tmuxRuntimeMock.openTarget).toHaveBeenCalled();
  });

  it("includes backend session reconciliation in repair output", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    backendReconcileMock.reconcileOfflineBackendSessionIds.mockReturnValueOnce({
      reconciled: [{ id: "claude-1", backendSessionId: "backend-1" }],
    });

    const response = await daemon.routeRequest(
      "POST",
      `${CORE_API_ROUTES.repairText}?projectRoot=${encodeURIComponent(projectRoot)}`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toContain("Recovered backend session id for 1 offline agent(s):");
    expect(response.body).toContain("  claude-1 -> backend-1");
  });

  it("rejects tmux doctor and repair routes without a project root", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();

    const doctor = await daemon.routeRequest("GET", CORE_API_ROUTES.doctorTmuxText);
    const repair = await daemon.routeRequest("POST", CORE_API_ROUTES.repairText);

    expect(doctor).toMatchObject({ status: 400, body: "projectRoot query is required\n" });
    expect(repair).toMatchObject({ status: 400, body: "projectRoot query is required\n" });
    expect(initPathsMock).not.toHaveBeenCalled();
  });

  it("keeps doctor and repair route failures as text/plain", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    runtimeCoherenceMock.buildRuntimeCoherenceReport.mockRejectedValueOnce(new Error("versions failed"));
    tmuxDoctorMock.buildTmuxDoctorReport.mockImplementationOnce(() => {
      throw new Error("tmux failed");
    });
    tmuxDoctorMock.repairTmuxRuntime.mockImplementationOnce(() => {
      throw new Error("repair failed");
    });

    const versions = await daemon.routeRequest("GET", CORE_API_ROUTES.doctorVersionsText);
    const tmux = await daemon.routeRequest(
      "GET",
      `${CORE_API_ROUTES.doctorTmuxText}?projectRoot=${encodeURIComponent(projectRoot)}`,
    );
    const repair = await daemon.routeRequest("POST", CORE_API_ROUTES.repairText, { projectRoot });

    expect(versions).toMatchObject({
      status: 500,
      contentType: "text/plain; charset=utf-8",
      body: "Error: versions failed\n",
    });
    expect(tmux).toMatchObject({
      status: 500,
      contentType: "text/plain; charset=utf-8",
      body: "Error: tmux failed\n",
    });
    expect(repair).toMatchObject({
      status: 500,
      contentType: "text/plain; charset=utf-8",
      body: "Error: repair failed\n",
    });
  });

  it("serves daemon status text for the installed shell shim", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    (daemon as any).state.projects[`proj-${basename(projectRoot)}`] = {
      projectId: `proj-${basename(projectRoot)}`,
      projectRoot,
      pid: process.pid,
      startedAt: STALE_SERVICE_TIMESTAMP,
      updatedAt: STALE_SERVICE_TIMESTAMP,
    };

    const response = await daemon.routeRequest("GET", CORE_API_ROUTES.daemonStatusText);

    expect(response.status).toBe(200);
    expect(response.contentType).toBe("text/plain; charset=utf-8");
    expect(response.body).toContain(`Daemon pid=${process.pid} port=43190`);
    expect(response.body).toContain("Known projects: 1");
    expect(response.body).toContain("Relay: off");
  });

  it("serves daemon ensure JSON for the installed shell shim", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();

    const response = await daemon.routeRequest("GET", `${CORE_API_ROUTES.daemonEnsureText}?json=1`);

    expect(response.status).toBe(200);
    expect(response.contentType).toBe("text/plain; charset=utf-8");
    expect(JSON.parse(response.body as string)).toEqual({
      daemon: {
        pid: process.pid,
        port: 43190,
        startedAt: expect.any(String),
        updatedAt: expect.any(String),
        serviceInfo: getProjectServiceManifest(),
      },
    });
  });

  it("serves host status text for the installed shell shim", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    await daemon.routeRequest("POST", CORE_API_ROUTES.commands, {
      command: CORE_COMMAND_NAMES.projectEnsure,
      payload: { projectRoot },
    });

    const response = await daemon.routeRequest(
      "GET",
      `${CORE_API_ROUTES.hostStatusText}?project=${encodeURIComponent(projectRoot)}`,
    );

    expect(response.status).toBe(200);
    expect(response.contentType).toBe("text/plain; charset=utf-8");
    expect(response.body).toContain("Service: live");
    expect(response.body).toContain(`Service pid=${process.pid}`);
    expect(response.body).toContain("Metadata: not running");
    expect(response.body).toContain("Tmux session: aimux-test");
    expect(ensureProjectPathsMock).toHaveBeenCalledWith(projectRoot);
  });

  it("serves host status JSON for the installed shell shim", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();

    const response = await daemon.routeRequest(
      "GET",
      `${CORE_API_ROUTES.hostStatusText}?json=1&project=${encodeURIComponent(projectRoot)}`,
    );

    expect(response.status).toBe(200);
    expect(response.contentType).toBe("text/plain; charset=utf-8");
    expect(JSON.parse(response.body as string)).toMatchObject({
      projectRoot,
      sessionName: "aimux-test",
      serviceAlive: false,
      metadataEndpoint: null,
      expectedServiceManifest: getProjectServiceManifest(),
    });
  });

  it("requires a project query for host status text", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();

    const response = await daemon.routeRequest("GET", CORE_API_ROUTES.hostStatusText);

    expect(response.status).toBe(400);
    expect(response.body).toBe("project query is required\n");
  });

  it("serves log path and tail text for the installed shell shim", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    const logPath = getProjectLogPathFor(projectRoot);
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, "one\ntwo\nthree\n");

    const path = await daemon.routeRequest(
      "GET",
      `${CORE_API_ROUTES.logsPathText}?project=${encodeURIComponent(projectRoot)}`,
    );
    const tail = await daemon.routeRequest(
      "GET",
      `${CORE_API_ROUTES.logsTailText}?project=${encodeURIComponent(projectRoot)}&lines=2`,
    );

    expect(path.status).toBe(200);
    expect(path.body).toBe(`${logPath}\n`);
    expect(tail.status).toBe(200);
    expect(tail.body).toBe("two\nthree\n");
  });

  it("clears daemon logs for the installed shell shim", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    const logPath = getDaemonLogPath();
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, "daemon log\n");

    const response = await daemon.routeRequest("POST", `${CORE_API_ROUTES.logsClearText}?daemon=1`);

    expect(response.status).toBe(200);
    expect(response.body).toBe(`Cleared ${logPath}\n`);
    expect(readFileSync(logPath, "utf8")).toBe("");
  });

  it("returns a text error for empty log tails", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();

    const response = await daemon.routeRequest(
      "GET",
      `${CORE_API_ROUTES.logsTailText}?project=${encodeURIComponent(projectRoot)}`,
    );

    expect(response.status).toBe(404);
    expect(response.contentType).toBe("text/plain; charset=utf-8");
    expect(response.body).toContain("No log entries at ");
  });

  it("serves metadata endpoint text through the daemon", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    writeMetadataEndpointFor(process.pid);

    const response = await daemon.routeRequest(
      "POST",
      `${CORE_API_ROUTES.metadataText}?project=${encodeURIComponent(projectRoot)}&arg=metadata&arg=endpoint`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toBe("http://127.0.0.1:44291\n");
    expect(coreActorMock.starts).toHaveBeenCalledWith(projectRoot);
  });

  it("forwards metadata mutations through the project service", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    writeMetadataEndpointFor(process.pid);
    vi.mocked(requestJson).mockImplementation(async (url: string, opts: { body?: unknown } = {}) => {
      if (url.endsWith(PROJECT_API_ROUTES.runtime.setContext)) {
        expect(opts.body).toEqual({
          session: "claude-1",
          context: {
            cwd: "/repo",
            branch: "feature",
            pr: { number: 42, title: "Ship it" },
          },
        });
        return { status: 200, json: { ok: true } };
      }
      return { status: 200, json: projectServiceHealth(process.pid) };
    });

    const args = [
      "metadata",
      "set-context",
      "claude-1",
      "--cwd",
      "/repo",
      "--branch=feature",
      "--pr-number",
      "42",
      "--pr-title",
      "Ship it",
    ].join("\n");
    const response = await daemon.routeRequest(
      "POST",
      `${CORE_API_ROUTES.metadataText}?project=${encodeURIComponent(projectRoot)}&args=${encodeURIComponent(args)}`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toBe("");
    expect(coreActorMock.starts).toHaveBeenCalledWith(projectRoot);
  });

  it("rejects malformed metadata text before calling the project service", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();

    const response = await daemon.routeRequest(
      "POST",
      `${CORE_API_ROUTES.metadataText}?project=${encodeURIComponent(projectRoot)}&arg=metadata&arg=set-status`,
    );

    expect(response.status).toBe(400);
    expect(response.body).toBe("metadata set-status requires <session> and <text>\n");
    expect(vi.mocked(requestJson)).not.toHaveBeenCalled();
  });

  it("serves host agent-read text through the project service", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    writeMetadataEndpointFor(process.pid);
    vi.mocked(requestJson).mockImplementation(async (url: string) => {
      if (url.includes(PROJECT_API_ROUTES.livePane.output)) {
        expect(url).toContain("sessionId=claude-1");
        expect(url).toContain("startLine=-80");
        return { status: 200, json: { ok: true, output: "pane output" } };
      }
      return { status: 200, json: projectServiceHealth(process.pid) };
    });

    const response = await daemon.routeRequest(
      "GET",
      `${CORE_API_ROUTES.hostAgentReadText}?project=${encodeURIComponent(
        projectRoot,
      )}&sessionId=claude-1&startLine=-80`,
    );

    expect(response.status).toBe(200);
    expect(response.contentType).toBe("text/plain; charset=utf-8");
    expect(response.body).toBe("pane output\n");
    expect(coreActorMock.starts).toHaveBeenCalledWith(projectRoot);
  });

  it("rejects malformed host agent-read start lines before calling the project service", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    writeMetadataEndpointFor(process.pid);

    const response = await daemon.routeRequest(
      "GET",
      `${CORE_API_ROUTES.hostAgentReadText}?project=${encodeURIComponent(
        projectRoot,
      )}&sessionId=claude-1&startLine=10px`,
    );

    expect(response.status).toBe(400);
    expect(response.body).toBe("Error: --start-line must be an integer\n");
    expect(vi.mocked(requestJson)).not.toHaveBeenCalled();
  });

  it("rejects unsafe host agent-read start lines before calling the project service", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    writeMetadataEndpointFor(process.pid);

    const response = await daemon.routeRequest(
      "GET",
      `${CORE_API_ROUTES.hostAgentReadText}?project=${encodeURIComponent(
        projectRoot,
      )}&sessionId=claude-1&startLine=9007199254740992`,
    );

    expect(response.status).toBe(400);
    expect(response.body).toBe("Error: --start-line must be a safe integer\n");
    expect(vi.mocked(requestJson)).not.toHaveBeenCalled();
  });

  it("streams host agent output through the daemon as plain text", async () => {
    const originalPort = process.env.AIMUX_DAEMON_PORT;
    const streamServer = createServer((req, res) => {
      expect(req.url).toContain(PROJECT_API_ROUTES.agents.outputStream);
      expect(req.url).toContain("sessionId=claude-1");
      expect(req.url).toContain("startLine=-80");
      expect(req.url).toContain("intervalMs=250");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: ready\n\n");
      res.write('event: output\ndata: {"output":"one"}\n\n');
      res.write('event: output\ndata: {"output":"one\\ntwo"}\n\n');
      res.end();
    });
    const servicePort = await listenOnLoopback(streamServer);
    const daemonPort = "49195";
    process.env.AIMUX_DAEMON_PORT = daemonPort;
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    writeMetadataEndpointFor(process.pid, servicePort);

    try {
      await daemon.start();
      const response = await fetch(
        `http://127.0.0.1:${daemonPort}${CORE_API_ROUTES.hostAgentStreamText}?project=${encodeURIComponent(
          projectRoot,
        )}&sessionId=claude-1&startLine=-80&intervalMs=250`,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/plain");
      expect(await response.text()).toBe("one\n\ntwo\n");
      expect(coreActorMock.starts).toHaveBeenCalledWith(projectRoot);
    } finally {
      daemon.stop();
      await closeServer(streamServer);
      if (originalPort === undefined) {
        delete process.env.AIMUX_DAEMON_PORT;
      } else {
        process.env.AIMUX_DAEMON_PORT = originalPort;
      }
    }
  });

  it("aborts the upstream host agent stream when the client disconnects", async () => {
    const originalPort = process.env.AIMUX_DAEMON_PORT;
    let closeUpstream: (() => void) | null = null;
    const upstreamClosed = new Promise<void>((resolve) => {
      closeUpstream = resolve;
    });
    const streamServer = createServer((req, res) => {
      req.on("close", () => closeUpstream?.());
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: output\ndata: {"output":"one"}\n\n');
    });
    const servicePort = await listenOnLoopback(streamServer);
    const daemonPort = "49198";
    process.env.AIMUX_DAEMON_PORT = daemonPort;
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    writeMetadataEndpointFor(process.pid, servicePort);

    try {
      await daemon.start();
      const response = await fetch(
        `http://127.0.0.1:${daemonPort}${CORE_API_ROUTES.hostAgentStreamText}?project=${encodeURIComponent(
          projectRoot,
        )}&sessionId=claude-1&startLine=-80&intervalMs=250`,
      );
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      const firstChunk = await reader!.read();
      expect(new TextDecoder().decode(firstChunk.value)).toBe("one\n");
      await reader!.cancel();
      await Promise.race([
        upstreamClosed,
        new Promise((_, reject) => setTimeout(() => reject(new Error("upstream stream stayed open")), 2_000)),
      ]);
    } finally {
      daemon.stop();
      await closeServer(streamServer);
      if (originalPort === undefined) {
        delete process.env.AIMUX_DAEMON_PORT;
      } else {
        process.env.AIMUX_DAEMON_PORT = originalPort;
      }
    }
  });

  it("returns text errors when the host agent stream endpoint is unreachable", async () => {
    const originalPort = process.env.AIMUX_DAEMON_PORT;
    const closedServer = createServer();
    const servicePort = await listenOnLoopback(closedServer);
    await closeServer(closedServer);
    const daemonPort = "49199";
    process.env.AIMUX_DAEMON_PORT = daemonPort;
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    writeMetadataEndpointFor(process.pid, servicePort);

    try {
      await daemon.start();
      const response = await fetch(
        `http://127.0.0.1:${daemonPort}${CORE_API_ROUTES.hostAgentStreamText}?project=${encodeURIComponent(
          projectRoot,
        )}&sessionId=claude-1&startLine=-80&intervalMs=250`,
      );

      expect(response.status).toBe(502);
      expect(response.headers.get("content-type")).toContain("text/plain");
      expect(await response.text()).toContain("fetch failed");
    } finally {
      daemon.stop();
      if (originalPort === undefined) {
        delete process.env.AIMUX_DAEMON_PORT;
      } else {
        process.env.AIMUX_DAEMON_PORT = originalPort;
      }
    }
  });

  it("rejects malformed host agent-stream parameters before opening the project stream", async () => {
    const originalPort = process.env.AIMUX_DAEMON_PORT;
    const daemonPort = "49196";
    process.env.AIMUX_DAEMON_PORT = daemonPort;
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    writeMetadataEndpointFor(process.pid);

    try {
      await daemon.start();
      const response = await fetch(
        `http://127.0.0.1:${daemonPort}${CORE_API_ROUTES.hostAgentStreamText}?project=${encodeURIComponent(
          projectRoot,
        )}&sessionId=claude-1&startLine=10px&intervalMs=250`,
      );

      expect(response.status).toBe(400);
      expect(await response.text()).toBe("Error: --start-line must be an integer\n");
      expect(coreActorMock.starts).not.toHaveBeenCalled();
    } finally {
      daemon.stop();
      if (originalPort === undefined) {
        delete process.env.AIMUX_DAEMON_PORT;
      } else {
        process.env.AIMUX_DAEMON_PORT = originalPort;
      }
    }
  });

  it("rejects too-fast host agent-stream intervals before opening the project stream", async () => {
    const originalPort = process.env.AIMUX_DAEMON_PORT;
    const daemonPort = "49197";
    process.env.AIMUX_DAEMON_PORT = daemonPort;
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    writeMetadataEndpointFor(process.pid);

    try {
      await daemon.start();
      const response = await fetch(
        `http://127.0.0.1:${daemonPort}${CORE_API_ROUTES.hostAgentStreamText}?project=${encodeURIComponent(
          projectRoot,
        )}&sessionId=claude-1&startLine=-80&intervalMs=99`,
      );

      expect(response.status).toBe(400);
      expect(await response.text()).toBe("Error: --interval-ms must be an integer >= 100\n");
      expect(coreActorMock.starts).not.toHaveBeenCalled();
    } finally {
      daemon.stop();
      if (originalPort === undefined) {
        delete process.env.AIMUX_DAEMON_PORT;
      } else {
        process.env.AIMUX_DAEMON_PORT = originalPort;
      }
    }
  });

  it("serves project ensure text for the installed shell shim", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();

    const response = await daemon.routeRequest(
      "POST",
      `${CORE_API_ROUTES.projectEnsureText}?project=${encodeURIComponent(projectRoot)}`,
    );

    expect(response.status).toBe(200);
    expect(response.contentType).toBe("text/plain; charset=utf-8");
    expect(response.body).toBe(`Ensured project service for ${projectRoot} (pid ${process.pid})\n`);
    expect(coreActorMock.starts).toHaveBeenCalledWith(projectRoot);
  });

  it("serves project ensure JSON for the installed shell shim", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();

    const response = await daemon.routeRequest(
      "POST",
      `${CORE_API_ROUTES.projectEnsureText}?json=1&project=${encodeURIComponent(projectRoot)}`,
    );

    expect(response.status).toBe(200);
    expect(response.contentType).toBe("text/plain; charset=utf-8");
    expect(JSON.parse(response.body as string)).toMatchObject({
      project: {
        projectId: `proj-${basename(projectRoot)}`,
        projectRoot,
        pid: process.pid,
      },
    });
  });

  it("serves project service management text for the installed shell shim", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();

    const serve = await daemon.routeRequest(
      "POST",
      `${CORE_API_ROUTES.projectServeText}?project=${encodeURIComponent(projectRoot)}`,
    );
    const stop = await daemon.routeRequest(
      "POST",
      `${CORE_API_ROUTES.projectStopText}?project=${encodeURIComponent(projectRoot)}`,
    );
    await daemon.routeRequest("POST", `${CORE_API_ROUTES.projectServeText}?project=${encodeURIComponent(projectRoot)}`);
    const kill = await daemon.routeRequest(
      "POST",
      `${CORE_API_ROUTES.projectKillText}?project=${encodeURIComponent(projectRoot)}`,
    );
    const restart = await daemon.routeRequest(
      "POST",
      `${CORE_API_ROUTES.projectRestartText}?project=${encodeURIComponent(projectRoot)}`,
    );
    const restartServe = await daemon.routeRequest(
      "POST",
      `${CORE_API_ROUTES.projectRestartText}?serve=1&project=${encodeURIComponent(projectRoot)}`,
    );

    expect(serve.body).toBe(`aimux serve: daemon managing ${projectRoot} (service pid ${process.pid})\n`);
    expect(stop.body).toBe(`Stopped project service pid ${process.pid}\n`);
    expect(kill.body).toBe(`Killed project service pid ${process.pid}\n`);
    expect(restart.body).toBe("Restarted project service for aimux-test\n");
    expect(restartServe.body).toBe(`Restarted project service for ${projectRoot}\n`);
    expect(coreActorMock.starts).toHaveBeenCalledWith(projectRoot);
    expect(coreActorMock.stops).toHaveBeenCalledWith(projectRoot);
    expect(coreActorMock.kills).toHaveBeenCalledWith(projectRoot);
    expect(dashboardTargetMock.resolveDashboardTarget).toHaveBeenCalledWith(projectRoot, expect.any(Object), {
      forceReload: true,
    });
  });

  it("focuses project restart text routes with explicit caller tmux context", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();

    const response = await daemon.routeRequest(
      "POST",
      `${CORE_API_ROUTES.projectRestartText}?open=1&currentClientSession=aimux-test-client-feedbeef&clientTty=%2Fdev%2Fttys001&project=${encodeURIComponent(projectRoot)}`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toBe("Restarted project service for aimux-test\n");
    expect(tmuxRuntimeMock.openTarget).toHaveBeenCalledWith(
      { sessionName: "aimux-test", windowId: "@2", windowIndex: 0, windowName: "dashboard" },
      {
        insideTmux: true,
        clientTty: "/dev/ttys001",
        returnSessionName: "aimux-test-client-feedbeef",
      },
    );
  });

  it("serves project service management JSON for the installed shell shim", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();

    const response = await daemon.routeRequest(
      "POST",
      `${CORE_API_ROUTES.projectRestartText}?json=1&serve=1&project=${encodeURIComponent(projectRoot)}`,
    );

    expect(response.status).toBe(200);
    const payload = JSON.parse(response.body as string);
    expect(payload).toMatchObject({
      projectRoot,
      project: {
        projectId: `proj-${basename(projectRoot)}`,
        projectRoot,
        pid: process.pid,
      },
    });
    expect(payload.dashboardTarget).toBeUndefined();
  });

  it("requires a project query for project ensure text", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();

    const response = await daemon.routeRequest("POST", CORE_API_ROUTES.projectEnsureText);

    expect(response.status).toBe(400);
    expect(response.body).toBe("project query is required\n");
    expect(coreActorMock.starts).not.toHaveBeenCalled();
  });

  it("serves lifecycle spawn text through the project service", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    writeMetadataEndpointFor(process.pid);
    vi.mocked(requestJson).mockImplementation(async (url: string, opts: { body?: unknown }) => {
      if (url.endsWith(PROJECT_API_ROUTES.agents.spawn)) {
        expect(opts.body).toEqual({ tool: "claude", worktreePath: join(tmpRoot, "work"), open: false });
        return { status: 200, json: { ok: true, sessionId: "claude-1" } };
      }
      return { status: 200, json: projectServiceHealth(process.pid) };
    });

    const response = await daemon.routeRequest("POST", CORE_API_ROUTES.lifecycleSpawnText, {
      project: projectRoot,
      tool: "claude",
      worktreePath: "../work",
      open: false,
    });

    expect(response.status).toBe(200);
    expect(response.body).toBe("spawned claude-1\n");
    expect(coreActorMock.starts).toHaveBeenCalledWith(projectRoot);
  });

  it("serves lifecycle stop text through the project service", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    writeMetadataEndpointFor(process.pid);
    vi.mocked(requestJson).mockImplementation(async (url: string, opts: { body?: unknown }) => {
      if (url.endsWith(PROJECT_API_ROUTES.agents.stop)) {
        expect(opts.body).toEqual({ sessionId: "claude-1" });
        return { status: 200, json: { ok: true, sessionId: "claude-1", status: "offline" } };
      }
      return { status: 200, json: projectServiceHealth(process.pid) };
    });

    const response = await daemon.routeRequest(
      "POST",
      `${CORE_API_ROUTES.lifecycleStopText}?project=${encodeURIComponent(projectRoot)}&sessionId=claude-1`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toBe("stopped claude-1\n");
    expect(coreActorMock.starts).not.toHaveBeenCalled();
  });

  it("serves lifecycle kill text through the project service", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    writeMetadataEndpointFor(process.pid);
    vi.mocked(requestJson).mockImplementation(async (url: string, opts: { body?: unknown }) => {
      if (url.endsWith(PROJECT_API_ROUTES.agents.kill)) {
        expect(opts.body).toEqual({ sessionId: "claude-1" });
        return {
          status: 200,
          json: { ok: true, sessionId: "claude-1", status: "graveyard", previousStatus: "offline" },
        };
      }
      return { status: 200, json: projectServiceHealth(process.pid) };
    });

    const response = await daemon.routeRequest(
      "POST",
      `${CORE_API_ROUTES.lifecycleKillText}?project=${encodeURIComponent(projectRoot)}&sessionId=claude-1`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toBe("graveyarded claude-1\n");
    expect(coreActorMock.starts).not.toHaveBeenCalled();
  });

  it("serves lifecycle fork JSON through the project service", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    writeMetadataEndpointFor(process.pid);
    vi.mocked(requestJson).mockImplementation(async (url: string, opts: { body?: unknown }) => {
      if (url.endsWith(PROJECT_API_ROUTES.agents.fork)) {
        expect(opts.body).toEqual({
          sourceSessionId: "claude-1",
          tool: "codex",
          instruction: "continue",
          open: true,
        });
        return { status: 200, json: { ok: true, sessionId: "codex-2", threadId: "thread-1" } };
      }
      return { status: 200, json: projectServiceHealth(process.pid) };
    });

    const response = await daemon.routeRequest(
      "POST",
      `${CORE_API_ROUTES.lifecycleForkText}?json=1&project=${encodeURIComponent(
        projectRoot,
      )}&sourceSessionId=claude-1&tool=codex&instruction=continue`,
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body as string)).toMatchObject({
      ok: true,
      projectRoot,
      sourceSessionId: "claude-1",
      sessionId: "codex-2",
      threadId: "thread-1",
      opened: true,
    });
  });

  it("serves agent input text through the project service", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    writeMetadataEndpointFor(process.pid);
    vi.mocked(requestJson).mockImplementation(async (url: string, opts: { body?: unknown }) => {
      if (url.endsWith(PROJECT_API_ROUTES.agents.input)) {
        expect(opts.body).toEqual({ sessionId: "claude-1", text: "hello" });
        return { status: 200, json: { ok: true } };
      }
      return { status: 200, json: projectServiceHealth(process.pid) };
    });

    const response = await daemon.routeRequest("POST", CORE_API_ROUTES.agentInputText, {
      project: projectRoot,
      sessionId: "claude-1",
      text: "hello",
    });

    expect(response.status).toBe(200);
    expect(response.body).toBe("delivered to claude-1\n");
    expect(coreActorMock.starts).toHaveBeenCalledWith(projectRoot);
  });

  it("serves agent ps text and JSON through the project service", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    writeMetadataEndpointFor(process.pid);
    const agents = [
      {
        id: "claude-1",
        tool: "claude",
        role: "coder",
        status: "ready",
        activity: "output",
        attention: "needs_response",
        loop: { active: true, goal: "ship" },
        overseer: true,
        worktreePath: "/repo/work",
        task: { description: "Fix bug", status: "open" },
      },
    ];
    vi.mocked(requestJson).mockImplementation(async (url: string) => {
      if (url.endsWith(PROJECT_API_ROUTES.agents.list)) {
        return { status: 200, json: { ok: true, agents } };
      }
      return { status: 200, json: projectServiceHealth(process.pid) };
    });

    const textResponse = await daemon.routeRequest(
      "GET",
      `${CORE_API_ROUTES.agentPsText}?project=${encodeURIComponent(projectRoot)}`,
    );
    const jsonResponse = await daemon.routeRequest(
      "GET",
      `${CORE_API_ROUTES.agentPsText}?json=1&project=${encodeURIComponent(projectRoot)}`,
    );

    expect(textResponse.status).toBe(200);
    expect(textResponse.body).toBe(
      "claude-1  [claude:coder]  ready  output/needs_response  {overseer loop:ship}\n" +
        "    worktree: /repo/work\n" +
        "    task: Fix bug (open)\n",
    );
    expect(JSON.parse(jsonResponse.body as string)).toEqual(agents);
    expect(coreActorMock.starts).toHaveBeenCalledWith(projectRoot);
  });

  it("serves agent rename and migrate JSON through the project service", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    writeMetadataEndpointFor(process.pid);
    const calls: Array<{ url: string; body?: unknown }> = [];
    vi.mocked(requestJson).mockImplementation(async (url: string, opts: { body?: unknown }) => {
      calls.push({ url, body: opts.body });
      if (url.endsWith(PROJECT_API_ROUTES.agents.rename)) {
        return { status: 200, json: { ok: true, sessionId: "claude-1", label: "reviewer" } };
      }
      if (url.endsWith(PROJECT_API_ROUTES.agents.migrate)) {
        return { status: 200, json: { ok: true, sessionId: "claude-1", worktreePath: join(projectRoot, "work") } };
      }
      return { status: 200, json: projectServiceHealth(process.pid) };
    });

    const renameResponse = await daemon.routeRequest(
      "POST",
      `${CORE_API_ROUTES.agentRenameText}?json=1&project=${encodeURIComponent(
        projectRoot,
      )}&sessionId=claude-1&label=reviewer`,
    );
    const migrateResponse = await daemon.routeRequest("POST", CORE_API_ROUTES.agentMigrateText, {
      project: projectRoot,
      sessionId: "claude-1",
      worktreePath: "work",
    });

    expect(renameResponse.status).toBe(200);
    expect(JSON.parse(renameResponse.body as string)).toEqual({
      ok: true,
      projectRoot,
      sessionId: "claude-1",
      label: "reviewer",
    });
    expect(migrateResponse.status).toBe(200);
    expect(migrateResponse.body).toBe(`migrated claude-1 -> ${join(projectRoot, "work")}\n`);
    expect(calls.find((call) => call.url.endsWith(PROJECT_API_ROUTES.agents.migrate))?.body).toEqual({
      sessionId: "claude-1",
      worktreePath: join(projectRoot, "work"),
    });
    expect(coreActorMock.starts).toHaveBeenCalledWith(projectRoot);
  });

  it("serves agent rename text when the project service clears the label", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    writeMetadataEndpointFor(process.pid);
    vi.mocked(requestJson).mockImplementation(async (url: string, opts: { body?: unknown }) => {
      if (url.endsWith(PROJECT_API_ROUTES.agents.rename)) {
        expect(opts.body).toEqual({ sessionId: "claude-1", label: "" });
        return { status: 200, json: { ok: true, sessionId: "claude-1" } };
      }
      return { status: 200, json: projectServiceHealth(process.pid) };
    });

    const response = await daemon.routeRequest("POST", CORE_API_ROUTES.agentRenameText, {
      project: projectRoot,
      sessionId: "claude-1",
      label: "",
    });

    expect(response.status).toBe(200);
    expect(response.body).toBe("renamed claude-1 ->\n");
  });

  it("returns project-service lifecycle errors as text without proxying through Node", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    writeMetadataEndpointFor(process.pid);
    vi.mocked(requestJson).mockImplementation(async (url: string) => {
      if (url.endsWith(PROJECT_API_ROUTES.agents.stop)) {
        return { status: 404, json: { ok: false, error: "session not found" } };
      }
      return { status: 200, json: projectServiceHealth(process.pid) };
    });

    const response = await daemon.routeRequest(
      "POST",
      `${CORE_API_ROUTES.lifecycleStopText}?project=${encodeURIComponent(projectRoot)}&sessionId=missing`,
    );

    expect(response.status).toBe(404);
    expect(response.body).toBe("Error: session not found\n");
  });

  it("returns lifecycle startup failures as text", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    coreActorMock.failStartFor.add(projectRoot);

    const response = await daemon.routeRequest("POST", CORE_API_ROUTES.lifecycleSpawnText, {
      project: projectRoot,
      tool: "claude",
    });

    expect(response.status).toBe(502);
    expect(response.contentType).toBe("text/plain; charset=utf-8");
    expect(response.body).toBe("Error: actor start failed\n");
  });

  it("serves loop exit text through the project service and records the status event", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    writeMetadataEndpointFor(process.pid);
    const calls: Array<{ url: string; body?: unknown }> = [];
    vi.mocked(requestJson).mockImplementation(async (url: string, opts: { body?: unknown }) => {
      calls.push({ url, body: opts.body });
      if (url.endsWith(PROJECT_API_ROUTES.agents.loop)) {
        return { status: 200, json: { ok: true, sessionId: "claude-1", loop: null } };
      }
      if (url.endsWith(PROJECT_API_ROUTES.runtime.event)) {
        return { status: 200, json: { ok: true } };
      }
      return { status: 200, json: projectServiceHealth(process.pid) };
    });

    const response = await daemon.routeRequest("POST", CORE_API_ROUTES.loopDoneText, {
      project: projectRoot,
      sessionId: "claude-1",
      reason: "done",
    });

    expect(response.status).toBe(200);
    expect(response.body).toBe("loop done claude-1\n");
    expect(calls.find((call) => call.url.endsWith(PROJECT_API_ROUTES.agents.loop))?.body).toEqual({
      sessionId: "claude-1",
      active: false,
    });
    expect(calls.find((call) => call.url.endsWith(PROJECT_API_ROUTES.runtime.event))?.body).toEqual({
      session: "claude-1",
      event: { kind: "task_done", message: "done", tone: "success", source: "loop" },
    });
  });

  it("serves overseer start and clear text through the project service", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    writeMetadataEndpointFor(process.pid);
    const calls: Array<{ url: string; body?: unknown }> = [];
    vi.mocked(requestJson).mockImplementation(async (url: string, opts: { body?: unknown }) => {
      calls.push({ url, body: opts.body });
      if (url.endsWith(PROJECT_API_ROUTES.agents.spawn)) {
        return { status: 200, json: { ok: true, sessionId: "codex-overseer" } };
      }
      if (url.endsWith(PROJECT_API_ROUTES.agents.overseer)) {
        return { status: 200, json: { ok: true, sessionId: "codex-overseer" } };
      }
      return { status: 200, json: projectServiceHealth(process.pid) };
    });

    const start = await daemon.routeRequest("POST", CORE_API_ROUTES.overseerStartText, {
      project: projectRoot,
      tool: "codex",
      worktreePath: "../work",
      open: false,
    });
    const clear = await daemon.routeRequest("POST", CORE_API_ROUTES.overseerClearText, {
      project: projectRoot,
      sessionId: "codex-overseer",
    });

    expect(start.status).toBe(200);
    expect(start.body).toBe("overseer codex-overseer\n");
    expect(clear.status).toBe(200);
    expect(clear.body).toBe("overseer cleared codex-overseer\n");
    expect(calls.find((call) => call.url.endsWith(PROJECT_API_ROUTES.agents.spawn))?.body).toEqual({
      tool: "codex",
      worktreePath: join(tmpRoot, "work"),
      open: false,
      overseer: true,
    });
    expect(calls.find((call) => call.url.endsWith(PROJECT_API_ROUTES.agents.overseer))?.body).toEqual({
      sessionId: "codex-overseer",
      active: false,
    });
  });

  it("serves team config text through the project service", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    writeMetadataEndpointFor(process.pid);
    const config = {
      defaultRole: "coder",
      roles: {
        coder: { description: "Writes code", reviewedBy: "reviewer" },
        reviewer: { description: "Reviews code", canEdit: true },
      },
    };
    const calls: Array<{ url: string; body?: unknown; timeoutMs?: number }> = [];
    vi.mocked(requestJson).mockImplementation(async (url: string, opts?: { body?: unknown; timeoutMs?: number }) => {
      calls.push({ url, body: opts?.body, timeoutMs: opts?.timeoutMs });
      if (url.endsWith(PROJECT_API_ROUTES.team.config)) {
        return { status: 200, json: { ok: true, config } };
      }
      if (url.endsWith(PROJECT_API_ROUTES.team.init)) {
        return { status: 200, json: { ok: true, config } };
      }
      if (
        url.endsWith(PROJECT_API_ROUTES.team.addRole) ||
        url.endsWith(PROJECT_API_ROUTES.team.removeRole) ||
        url.endsWith(PROJECT_API_ROUTES.team.defaultRole)
      ) {
        return { status: 200, json: { ok: true, config } };
      }
      return { status: 200, json: projectServiceHealth(process.pid) };
    });

    const show = await daemon.routeRequest(
      "GET",
      `${CORE_API_ROUTES.teamShowText}?project=${encodeURIComponent(projectRoot)}`,
    );
    const add = await daemon.routeRequest("POST", CORE_API_ROUTES.teamAddText, {
      project: projectRoot,
      role: "planner",
      description: "Plans work",
      reviewedBy: "reviewer",
      canEdit: true,
    });
    const defaulted = await daemon.routeRequest("POST", CORE_API_ROUTES.teamDefaultText, {
      project: projectRoot,
      role: "planner",
    });
    const removed = await daemon.routeRequest("POST", CORE_API_ROUTES.teamRemoveText, {
      project: projectRoot,
      role: "planner",
    });
    const initialized = await daemon.routeRequest("POST", CORE_API_ROUTES.teamInitText, {
      project: projectRoot,
    });

    expect(show.status).toBe(200);
    expect(show.body).toBe(
      "Team Roles:\n  coder: Writes code (reviewed by: reviewer)\n  reviewer: Reviews code (can edit)\n\nDefault role: coder\n",
    );
    expect(add.body).toBe('Role "planner" saved.\n');
    expect(defaulted.body).toBe('Default role set to "planner".\n');
    expect(removed.body).toBe('Role "planner" removed.\n');
    expect(initialized.body).toBe(
      "Team config initialized with default roles:\n  coder: Writes code\n  reviewer: Reviews code\n",
    );
    expect(calls.find((call) => call.url.endsWith(PROJECT_API_ROUTES.team.addRole))?.body).toEqual({
      role: "planner",
      description: "Plans work",
      reviewedBy: "reviewer",
      canEdit: true,
    });
    expect(calls.find((call) => call.url.endsWith(PROJECT_API_ROUTES.team.addRole))?.timeoutMs).toBe(120_000);
    expect(calls.find((call) => call.url.endsWith(PROJECT_API_ROUTES.team.defaultRole))?.body).toEqual({
      role: "planner",
    });
    expect(calls.find((call) => call.url.endsWith(PROJECT_API_ROUTES.team.defaultRole))?.timeoutMs).toBe(120_000);
    expect(calls.find((call) => call.url.endsWith(PROJECT_API_ROUTES.team.removeRole))?.body).toEqual({
      role: "planner",
    });
    expect(calls.find((call) => call.url.endsWith(PROJECT_API_ROUTES.team.removeRole))?.timeoutMs).toBe(120_000);
    expect(calls.find((call) => call.url.endsWith(PROJECT_API_ROUTES.team.init))?.timeoutMs).toBe(120_000);
  });

  it("serves notification text routes through the project service", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    writeMetadataEndpointFor(process.pid);
    const calls: Array<{ url: string; body?: unknown; timeoutMs?: number }> = [];
    vi.mocked(requestJson).mockImplementation(async (url: string, opts?: { body?: unknown; timeoutMs?: number }) => {
      calls.push({ url, body: opts?.body, timeoutMs: opts?.timeoutMs });
      if (url.endsWith(PROJECT_API_ROUTES.runtime.notify)) {
        return { status: 200, json: { ok: true } };
      }
      if (url.endsWith(PROJECT_API_ROUTES.notifications.read)) {
        return { status: 200, json: { ok: true, updated: 2 } };
      }
      if (url.endsWith(PROJECT_API_ROUTES.notifications.clear)) {
        return { status: 200, json: { ok: true, cleared: 3 } };
      }
      if (url.includes(PROJECT_API_ROUTES.notifications.list)) {
        return {
          status: 200,
          json: {
            ok: true,
            notifications: [
              {
                id: "note-1",
                title: "Needs attention",
                body: "Claude is waiting",
                unread: true,
                sessionId: "claude-1",
                createdAt: "2026-01-01T00:00:00.000Z",
              },
            ],
            unreadCount: 1,
          },
        };
      }
      return { status: 200, json: projectServiceHealth(process.pid) };
    });

    const listed = await daemon.routeRequest(
      "GET",
      `${CORE_API_ROUTES.notificationListText}?project=${encodeURIComponent(projectRoot)}&unread=1&sessionId=claude-1`,
    );
    const sent = await daemon.routeRequest("POST", `${CORE_API_ROUTES.notificationSendText}?json=1`, {
      project: projectRoot,
      title: "Heads up",
      subtitle: "Claude",
      body: "Ready",
      sessionId: "claude-1",
      kind: "attention",
    });
    const read = await daemon.routeRequest("POST", CORE_API_ROUTES.notificationReadText, {
      project: projectRoot,
      id: "note-1",
      ids: ["note-2", "note-3"],
      sessionId: "claude-1",
    });
    const cleared = await daemon.routeRequest("POST", `${CORE_API_ROUTES.notificationClearText}?json=1`, {
      project: projectRoot,
      ids: "note-4,note-5",
      sessionId: "claude-1",
    });

    expect(listed.status).toBe(200);
    expect(listed.body).toBe("note-1 unread [claude-1] Needs attention: Claude is waiting\n");
    expect(sent.status).toBe(200);
    expect(JSON.parse(sent.body as string)).toEqual({ ok: true });
    expect(read.body).toBe("Marked 2 notifications as read.\n");
    expect(JSON.parse(cleared.body as string)).toEqual({ ok: true, cleared: 3 });
    expect(calls.find((call) => call.url.includes(PROJECT_API_ROUTES.notifications.list))?.url).toContain("unread=1");
    expect(calls.find((call) => call.url.endsWith(PROJECT_API_ROUTES.runtime.notify))?.body).toEqual({
      title: "Heads up",
      subtitle: "Claude",
      message: "Ready",
      sessionId: "claude-1",
      kind: "attention",
      force: true,
    });
    expect(calls.find((call) => call.url.endsWith(PROJECT_API_ROUTES.runtime.notify))?.timeoutMs).toBe(120_000);
    expect(calls.find((call) => call.url.endsWith(PROJECT_API_ROUTES.notifications.read))?.body).toEqual({
      id: "note-1",
      ids: ["note-2", "note-3"],
      sessionId: "claude-1",
    });
    expect(calls.find((call) => call.url.endsWith(PROJECT_API_ROUTES.notifications.clear))?.body).toEqual({
      ids: ["note-4", "note-5"],
      sessionId: "claude-1",
    });
  });

  it("rejects malformed lifecycle project-service responses", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    writeMetadataEndpointFor(process.pid);
    vi.mocked(requestJson).mockImplementation(async (url: string) => {
      if (url.endsWith(PROJECT_API_ROUTES.agents.spawn)) {
        return { status: 200, json: { ok: true } };
      }
      return { status: 200, json: projectServiceHealth(process.pid) };
    });

    const response = await daemon.routeRequest("POST", CORE_API_ROUTES.lifecycleSpawnText, {
      project: projectRoot,
      tool: "claude",
    });

    expect(response.status).toBe(502);
    expect(response.body).toBe("Error: project service returned invalid spawn response: sessionId is required\n");
  });

  it("preserves daemon status JSON shape for the installed shell shim", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();

    const response = await daemon.routeRequest("GET", `${CORE_API_ROUTES.daemonStatusText}?json=1`);

    expect(response.status).toBe(200);
    expect(response.contentType).toBe("text/plain; charset=utf-8");
    expect(JSON.parse(response.body as string).daemon.serviceInfo).toEqual(getProjectServiceManifest());
  });

  it("serves project list text for the installed shell shim", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();

    const daemonProjects = await daemon.routeRequest("GET", CORE_API_ROUTES.daemonProjectsText);
    const projectsList = await daemon.routeRequest("GET", CORE_API_ROUTES.projectsListText);

    expect(daemonProjects.status).toBe(200);
    expect(daemonProjects.body).toBe(`${basename(projectRoot)}  idle  ${projectRoot}\n`);
    expect(projectsList.status).toBe(200);
    expect(projectsList.body).toBe(`${basename(projectRoot)}  idle  ${projectRoot}\n`);
  });

  it("serves remote status text for the installed shell shim without leaking tokens", async () => {
    const { saveCredentials } = await import("./credentials.js");
    const { AimuxDaemon } = await import("./daemon.js");
    saveCredentials({
      version: 1,
      relayUrl: "wss://relay.example",
      token: "secret-token",
      userId: "user_123",
      createdAt: new Date().toISOString(),
      remoteEnabled: true,
    });
    const daemon = new AimuxDaemon();

    const response = await daemon.routeRequest("GET", CORE_API_ROUTES.remoteStatusText);

    expect(response.status).toBe(200);
    expect(response.contentType).toBe("text/plain; charset=utf-8");
    expect(response.body).toBe("Remote access: enabled\nRelay: wss://relay.example\nConnection: off\n");
    expect(response.body).not.toContain("secret-token");
  });

  it("preserves remote status JSON shape for the installed shell shim", async () => {
    const { saveCredentials } = await import("./credentials.js");
    const { AimuxDaemon } = await import("./daemon.js");
    saveCredentials({
      version: 1,
      relayUrl: "wss://relay.example",
      token: "secret-token",
      userId: "user_123",
      createdAt: new Date().toISOString(),
      remoteEnabled: true,
    });
    const daemon = new AimuxDaemon();

    const response = await daemon.routeRequest("GET", `${CORE_API_ROUTES.remoteStatusText}?json=1`);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body as string)).toEqual({ loggedIn: true, relay: { status: "off" } });
    expect(response.body).not.toContain("secret-token");
  });

  it("serves whoami text and JSON for the installed shell shim without leaking tokens", async () => {
    const { saveCredentials } = await import("./credentials.js");
    const { AimuxDaemon } = await import("./daemon.js");
    saveCredentials({
      version: 1,
      relayUrl: "wss://relay.example",
      token: "secret-token",
      userId: "user_123",
      createdAt: new Date().toISOString(),
      remoteEnabled: true,
    });
    const daemon = new AimuxDaemon();

    const text = await daemon.routeRequest("GET", CORE_API_ROUTES.whoamiText);
    const json = await daemon.routeRequest("GET", `${CORE_API_ROUTES.whoamiText}?json=1`);

    expect(text.status).toBe(200);
    expect(text.body).toBe("Logged in as user_123\nRelay: wss://relay.example\nRemote access: enabled\n");
    expect(text.body).not.toContain("secret-token");
    expect(json.status).toBe(200);
    expect(JSON.parse(json.body as string)).toEqual({
      loggedIn: true,
      userId: "user_123",
      relayUrl: "wss://relay.example",
      remoteEnabled: true,
    });
    expect(json.body).not.toContain("secret-token");
  });

  it("serves logout text and clears credentials for the installed shell shim", async () => {
    const { saveCredentials, loadCredentials } = await import("./credentials.js");
    const { AimuxDaemon } = await import("./daemon.js");
    saveCredentials({
      version: 1,
      relayUrl: "wss://relay.example",
      token: "secret-token",
      userId: "user_123",
      createdAt: new Date().toISOString(),
      remoteEnabled: true,
    });
    const daemon = new AimuxDaemon();

    const response = await daemon.routeRequest("POST", CORE_API_ROUTES.logoutText);

    expect(response.status).toBe(200);
    expect(response.body).toBe("✓ Logged out. Remote access disabled.\n");
    expect(loadCredentials()).toBeNull();
  });

  it("serves login text through the daemon auth flow", async () => {
    const { saveCredentials } = await import("./credentials.js");
    const { AimuxDaemon } = await import("./daemon.js");
    loginFlowMock.mockImplementation(async (opts: { onMessage?: (line: string) => void }) => {
      opts.onMessage?.("Opening your browser to sign in...");
      opts.onMessage?.("  https://aimux.app/cli-auth");
      saveCredentials({
        version: 1,
        relayUrl: "wss://relay.example",
        token: "secret-token",
        userId: "user_123",
        createdAt: new Date().toISOString(),
        remoteEnabled: true,
      });
      return { userId: "user_123" };
    });
    const previousWebSocket = globalThis.WebSocket;
    class FakeWebSocket extends EventTarget {
      constructor(
        readonly url: string,
        readonly protocols: string[],
      ) {
        super();
      }

      close(): void {
        this.dispatchEvent(new Event("close"));
      }
    }
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    try {
      const daemon = new AimuxDaemon();

      const response = await daemon.routeRequest("POST", CORE_API_ROUTES.loginText);

      expect(response.status).toBe(200);
      expect(response.body).toBe(
        "Opening your browser to sign in...\n  https://aimux.app/cli-auth\n\n✓ Logged in as user_123\nRemote access is enabled (connection: connecting).\n",
      );
      expect(response.body).not.toContain("secret-token");
      expect(loginFlowMock).toHaveBeenCalledWith({
        action: undefined,
        onMessage: expect.any(Function),
      });
    } finally {
      globalThis.WebSocket = previousWebSocket;
    }
  });

  it("serves security unlock text through the daemon auth flow", async () => {
    const { saveCredentials } = await import("./credentials.js");
    const { AimuxDaemon } = await import("./daemon.js");
    loginFlowMock.mockImplementation(async () => {
      saveCredentials({
        version: 1,
        relayUrl: "wss://relay.example",
        token: "secret-token",
        userId: "user_123",
        createdAt: new Date().toISOString(),
        remoteEnabled: true,
      });
      return { userId: "user_123" };
    });
    const previousWebSocket = globalThis.WebSocket;
    class FakeWebSocket extends EventTarget {
      close(): void {
        this.dispatchEvent(new Event("close"));
      }
    }
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    try {
      const daemon = new AimuxDaemon();

      const response = await daemon.routeRequest("POST", CORE_API_ROUTES.securityUnlockText);

      expect(response.status).toBe(200);
      expect(response.body).toBe(
        "\n✓ Security unlocked for user_123\nRemote access is enabled (connection: connecting).\n",
      );
      expect(loginFlowMock).toHaveBeenCalledWith({
        action: "security-unlock",
        onMessage: expect.any(Function),
      });
    } finally {
      globalThis.WebSocket = previousWebSocket;
    }
  });

  it("starts then waits on a daemon-owned login auth session", async () => {
    const { saveCredentials } = await import("./credentials.js");
    const { AimuxDaemon } = await import("./daemon.js");
    let completeLogin: (() => void) | null = null;
    loginFlowMock.mockImplementation(
      (opts: { onMessage?: (line: string) => void }) =>
        new Promise<{ userId: string }>((resolve) => {
          opts.onMessage?.("Opening your browser to sign in...");
          opts.onMessage?.("  https://aimux.app/cli-auth");
          completeLogin = () => {
            saveCredentials({
              version: 1,
              relayUrl: "wss://relay.example",
              token: "secret-token",
              userId: "user_123",
              createdAt: new Date().toISOString(),
              remoteEnabled: true,
            });
            resolve({ userId: "user_123" });
          };
        }),
    );
    const previousWebSocket = globalThis.WebSocket;
    class FakeWebSocket extends EventTarget {
      close(): void {
        this.dispatchEvent(new Event("close"));
      }
    }
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    try {
      const daemon = new AimuxDaemon();

      const start = await daemon.routeRequest("POST", CORE_API_ROUTES.loginStartText);
      expect(start.status).toBe(200);
      expect(String(start.body)).toContain("Opening your browser to sign in...");
      const sessionId = String(start.body).match(/^auth-session: ([^\n]+)/)?.[1];
      expect(sessionId).toBeTruthy();

      completeLogin?.();
      const wait = await daemon.routeRequest("POST", `${CORE_API_ROUTES.loginWaitText}?id=${sessionId}`);

      expect(wait.status).toBe(200);
      expect(wait.body).toBe("\n✓ Logged in as user_123\nRemote access is enabled (connection: connecting).\n");
      expect(wait.body).not.toContain("secret-token");
    } finally {
      globalThis.WebSocket = previousWebSocket;
    }
  });

  it("rejects auth browser routes from relay actors", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    const headers = { "x-aimux-actor-role": "owner", "x-aimux-actor-user-id": "user_123" };

    const start = await daemon.routeRequest("POST", CORE_API_ROUTES.loginStartText, undefined, headers);
    const unlock = await daemon.routeRequest("POST", CORE_API_ROUTES.securityUnlockText, undefined, headers);

    expect(start).toMatchObject({ status: 403, body: "auth routes are loopback-only\n" });
    expect(unlock).toMatchObject({ status: 403, body: "auth routes are loopback-only\n" });
    expect(loginFlowMock).not.toHaveBeenCalled();
  });

  it("rejects core text routes from relay actors", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    const headers = { "x-aimux-actor-role": "owner", "x-aimux-actor-user-id": "user_123" };

    const spawn = await daemon.routeRequest(
      "POST",
      `${CORE_API_ROUTES.lifecycleSpawnText}?project=${encodeURIComponent(projectRoot)}&tool=claude`,
      undefined,
      headers,
    );
    const worktrees = await daemon.routeRequest(
      "GET",
      `${CORE_API_ROUTES.worktreeListText}?project=${encodeURIComponent(projectRoot)}`,
      undefined,
      headers,
    );
    const doctor = await daemon.routeRequest("GET", CORE_API_ROUTES.doctorVersionsText, undefined, headers);
    const metadata = await daemon.routeRequest(
      "POST",
      `${CORE_API_ROUTES.metadataText}?project=${encodeURIComponent(projectRoot)}&arg=metadata&arg=set-status`,
      undefined,
      headers,
    );
    const repair = await daemon.routeRequest(
      "POST",
      `${CORE_API_ROUTES.repairText}?projectRoot=${encodeURIComponent(projectRoot)}`,
      undefined,
      headers,
    );
    const restart = await daemon.routeRequest("POST", CORE_API_ROUTES.restartText, undefined, headers);
    const projectEnsure = await daemon.routeRequest(
      "POST",
      `${CORE_API_ROUTES.projectEnsureText}?project=${encodeURIComponent(projectRoot)}`,
      undefined,
      headers,
    );

    expect(spawn).toMatchObject({ status: 403, body: "core text routes are loopback-only\n" });
    expect(worktrees).toMatchObject({ status: 403, body: "core text routes are loopback-only\n" });
    expect(doctor).toMatchObject({ status: 403, body: "core text routes are loopback-only\n" });
    expect(metadata).toMatchObject({ status: 403, body: "core text routes are loopback-only\n" });
    expect(repair).toMatchObject({ status: 403, body: "core text routes are loopback-only\n" });
    expect(restart).toMatchObject({ status: 403, body: "core text routes are loopback-only\n" });
    expect(projectEnsure).toMatchObject({ status: 403, body: "core text routes are loopback-only\n" });
    expect(coreActorMock.starts).not.toHaveBeenCalled();
  });

  it("serves worktree text routes through the project service", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    writeMetadataEndpointFor(process.pid);
    vi.mocked(requestJson).mockImplementation(
      async (url: string, opts: { body?: unknown; timeoutMs?: number } = {}) => {
        if (url.endsWith(PROJECT_API_ROUTES.worktrees)) {
          return {
            status: 200,
            json: { ok: true, worktrees: [{ name: "main", branch: "master", path: projectRoot }] },
          };
        }
        if (url.endsWith(PROJECT_API_ROUTES.worktreeActions.create)) {
          expect(opts.body).toEqual({ name: "feature" });
          return {
            status: 200,
            json: { ok: true, path: `${projectRoot}/.aimux/worktrees/feature`, status: "created" },
          };
        }
        if (url.endsWith(PROJECT_API_ROUTES.worktreeActions.remove)) {
          expect(opts.body).toEqual({ path: `${projectRoot}/relative` });
          expect(opts.timeoutMs).toBe(120_000);
          return { status: 200, json: { ok: true, path: `${projectRoot}/relative`, status: "removed" } };
        }
        return { status: 200, json: projectServiceHealth(process.pid) };
      },
    );

    const listed = await daemon.routeRequest(
      "GET",
      `${CORE_API_ROUTES.worktreeListText}?project=${encodeURIComponent(projectRoot)}`,
    );
    const listedJson = await daemon.routeRequest(
      "GET",
      `${CORE_API_ROUTES.worktreeListText}?project=${encodeURIComponent(projectRoot)}&json=1`,
    );
    const created = await daemon.routeRequest(
      "POST",
      `${CORE_API_ROUTES.worktreeCreateText}?project=${encodeURIComponent(projectRoot)}&name=feature`,
    );
    const removed = await daemon.routeRequest("POST", CORE_API_ROUTES.worktreeRemoveText, {
      project: projectRoot,
      path: "relative",
    });

    expect(listed.body).toContain("main");
    expect(JSON.parse(String(listedJson.body))).toEqual([{ name: "main", branch: "master", path: projectRoot }]);
    expect(created.body).toBe(`Created worktree "feature" at ${projectRoot}/.aimux/worktrees/feature\n`);
    expect(removed.body).toBe(`removed ${projectRoot}/relative\n`);
  });

  it("serves graveyard text routes through the project service", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    writeMetadataEndpointFor(process.pid);
    vi.mocked(requestJson).mockImplementation(
      async (url: string, opts: { body?: unknown; timeoutMs?: number } = {}) => {
        if (url.endsWith(PROJECT_API_ROUTES.graveyard)) {
          return { status: 200, json: { ok: true, entries: [{ id: "claude-1", tool: "claude" }], worktrees: [] } };
        }
        if (url.endsWith(PROJECT_API_ROUTES.graveyardActions.resurrectAgent)) {
          expect(opts.body).toEqual({ sessionId: "claude-1" });
          expect(opts.timeoutMs).toBe(120_000);
          return { status: 200, json: { ok: true, sessionId: "claude-1", status: "offline" } };
        }
        if (url.endsWith(PROJECT_API_ROUTES.agents.kill)) {
          expect(opts.body).toEqual({ sessionId: "claude-1" });
          expect(opts.timeoutMs).toBe(120_000);
          return { status: 200, json: { ok: true, sessionId: "claude-1", status: "graveyard" } };
        }
        if (url.endsWith(PROJECT_API_ROUTES.graveyardActions.cleanup)) {
          expect(opts.body).toEqual({ dryRun: true });
          expect(opts.timeoutMs).toBe(120_000);
          return {
            status: 200,
            json: {
              ok: true,
              dryRun: true,
              plan: { enabled: true, retentionDays: 30 },
              results: [{ kind: "agent", id: "claude-old", status: "dry-run" }],
            },
          };
        }
        return { status: 200, json: projectServiceHealth(process.pid) };
      },
    );

    const listed = await daemon.routeRequest(
      "GET",
      `${CORE_API_ROUTES.graveyardListText}?project=${encodeURIComponent(projectRoot)}`,
    );
    const resurrected = await daemon.routeRequest(
      "POST",
      `${CORE_API_ROUTES.graveyardResurrectText}?project=${encodeURIComponent(projectRoot)}&sessionId=claude-1`,
    );
    const sent = await daemon.routeRequest(
      "POST",
      `${CORE_API_ROUTES.graveyardSendText}?project=${encodeURIComponent(projectRoot)}&sessionId=claude-1`,
    );
    const cleanup = await daemon.routeRequest(
      "POST",
      `${CORE_API_ROUTES.graveyardCleanupText}?project=${encodeURIComponent(projectRoot)}&dryRun=1`,
    );

    expect(listed.body).toContain("claude-1");
    expect(resurrected.body).toBe("resurrected claude-1\n");
    expect(sent.body).toBe("graveyarded claude-1\n");
    expect(cleanup.body).toContain("Graveyard cleanup would remove 1 item(s); 0 failed.");
  });

  it("serves thread and message text routes through the project service", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    writeMetadataEndpointFor(process.pid);
    vi.mocked(requestJson).mockImplementation(
      async (url: string, opts: { body?: unknown; timeoutMs?: number } = {}) => {
        if (url.endsWith(`${PROJECT_API_ROUTES.threads.list}?session=claude-1`)) {
          return {
            status: 200,
            json: [
              {
                thread: {
                  id: "thread-1",
                  kind: "conversation",
                  status: "open",
                  title: "Hello",
                  unreadBy: ["user"],
                  waitingOn: ["claude-1"],
                },
                latestMessage: { from: "claude-1", kind: "reply", body: "done" },
              },
            ] as any,
          };
        }
        if (url.endsWith(`${PROJECT_API_ROUTES.threads.list}/thread-1`)) {
          return {
            status: 200,
            json: {
              thread: {
                id: "thread-1",
                kind: "conversation",
                status: "open",
                title: "Hello",
                participants: ["user", "claude-1"],
              },
              messages: [{ id: "msg-1", ts: "2026-01-01T00:00:00.000Z", from: "user", kind: "request", body: "hi" }],
            },
          };
        }
        if (url.endsWith(PROJECT_API_ROUTES.threads.open)) {
          expect(opts.body).toEqual({
            title: "Hello",
            from: "user",
            participants: ["claude-1", "codex-1"],
            kind: "conversation",
          });
          expect(opts.timeoutMs).toBe(120_000);
          return { status: 200, json: { ok: true, thread: { id: "thread-2", status: "open" } } };
        }
        if (url.endsWith(PROJECT_API_ROUTES.threads.send)) {
          expect(opts.timeoutMs).toBe(120_000);
          if ((opts.body as any).threadId === "thread-1") {
            expect(opts.body).toEqual({
              threadId: "thread-1",
              from: "user",
              to: ["claude-1"],
              kind: "note",
              body: "ping",
            });
            return { status: 200, json: { ok: true, message: { id: "msg-2" } } };
          }
          expect(opts.body).toMatchObject({
            from: "user",
            to: ["claude-1"],
            assignee: "coder",
            tool: "claude",
            worktreePath: "feature",
            kind: "request",
            body: "please",
            title: "Ask",
          });
          return {
            status: 200,
            json: { ok: true, thread: { id: "thread-3" }, message: { id: "msg-3" }, deliveredTo: ["claude-1"] },
          };
        }
        if (url.endsWith(PROJECT_API_ROUTES.threads.markSeen)) {
          expect(opts.body).toEqual({ threadId: "thread-1", session: "user" });
          expect(opts.timeoutMs).toBe(120_000);
          return { status: 200, json: { ok: true } };
        }
        if (url.endsWith(PROJECT_API_ROUTES.threads.status)) {
          expect(opts.body).toEqual({
            threadId: "thread-1",
            status: "waiting",
            owner: "user",
            waitingOn: ["claude-1"],
          });
          expect(opts.timeoutMs).toBe(120_000);
          return { status: 200, json: { ok: true, thread: { id: "thread-1", status: "waiting" } } };
        }
        return { status: 200, json: projectServiceHealth(process.pid) };
      },
    );

    const listed = await daemon.routeRequest(
      "GET",
      `${CORE_API_ROUTES.threadsListText}?project=${encodeURIComponent(projectRoot)}&session=claude-1`,
    );
    const listedJson = await daemon.routeRequest(
      "GET",
      `${CORE_API_ROUTES.threadListText}?json=1&project=${encodeURIComponent(projectRoot)}&session=claude-1`,
    );
    const shown = await daemon.routeRequest(
      "GET",
      `${CORE_API_ROUTES.threadShowText}?project=${encodeURIComponent(projectRoot)}&threadId=thread-1`,
    );
    const opened = await daemon.routeRequest("POST", CORE_API_ROUTES.threadOpenText, {
      project: projectRoot,
      title: "Hello",
      from: "user",
      participants: "claude-1,codex-1",
    });
    const sent = await daemon.routeRequest("POST", CORE_API_ROUTES.threadSendText, {
      project: projectRoot,
      threadId: "thread-1",
      body: "ping",
      from: "user",
      to: "claude-1",
    });
    const seen = await daemon.routeRequest("POST", CORE_API_ROUTES.threadMarkSeenText, {
      project: projectRoot,
      threadId: "thread-1",
      session: "user",
    });
    const status = await daemon.routeRequest("POST", CORE_API_ROUTES.threadStatusText, {
      project: projectRoot,
      threadId: "thread-1",
      status: "waiting",
      owner: "user",
      waitingOn: "claude-1",
    });
    const message = await daemon.routeRequest("POST", CORE_API_ROUTES.messageSendText, {
      project: projectRoot,
      body: "please",
      to: "claude-1",
      assignee: "coder",
      tool: "claude",
      worktree: "feature",
      title: "Ask",
    });
    const emptyParticipants = await daemon.routeRequest("POST", CORE_API_ROUTES.threadOpenText, {
      project: projectRoot,
      title: "Empty",
      from: "user",
      participants: " , ",
    });

    expect(listed.body).toContain("thread-1  conversation  open unread=1 waiting=claude-1");
    expect(JSON.parse(String(listedJson.body))).toHaveLength(1);
    expect(shown.body).toContain("Hello (conversation)");
    expect(opened.body).toBe("thread-2\n");
    expect(sent.body).toBe("msg-2\n");
    expect(seen.body).toBe("ok\n");
    expect(status.body).toBe("thread thread-1\nstatus waiting\n");
    expect(message.body).toBe("thread thread-3\nmessage msg-3\ndelivered claude-1\n");
    expect(emptyParticipants.status).toBe(400);
    expect(emptyParticipants.body).toBe("participants is required\n");
  });

  it("serves workflow text routes through the project service", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    writeMetadataEndpointFor(process.pid);
    vi.mocked(requestJson).mockImplementation(
      async (url: string, opts: { body?: unknown; timeoutMs?: number } = {}) => {
        if (url.endsWith(`${PROJECT_API_ROUTES.tasks.list}?session=claude-1&status=todo`)) {
          return {
            status: 200,
            json: {
              ok: true,
              tasks: [
                {
                  id: "task-1",
                  type: "task",
                  status: "todo",
                  assignedBy: "user",
                  assignedTo: "claude-1",
                  description: "Ship it",
                  threadId: "thread-1",
                },
              ],
            },
          };
        }
        if (url.endsWith(`${PROJECT_API_ROUTES.tasks.list}/task-1`)) {
          return {
            status: 200,
            json: {
              ok: true,
              task: {
                id: "task-1",
                type: "task",
                status: "todo",
                assignedBy: "user",
                assignedTo: "claude-1",
                description: "Ship it",
                prompt: "Implement it",
                threadId: "thread-1",
              },
              thread: { id: "thread-1" },
              messages: [],
            },
          };
        }
        if (url.endsWith(PROJECT_API_ROUTES.handoff.send)) {
          expect(opts.body).toEqual({
            from: "user",
            to: ["claude-1"],
            assignee: "coder",
            tool: "claude",
            body: "Take over",
            title: "Handoff",
            worktreePath: "feature",
          });
          expect(opts.timeoutMs).toBe(120_000);
          return {
            status: 200,
            json: { ok: true, thread: { id: "thread-2" }, message: { id: "msg-2" }, deliveredTo: ["claude-1"] },
          };
        }
        if (url.endsWith(PROJECT_API_ROUTES.handoff.accept)) {
          expect(opts.body).toEqual({ threadId: "thread-2", from: "claude-1", body: "ok" });
          return { status: 200, json: { ok: true, thread: { id: "thread-2" }, message: { id: "msg-3" } } };
        }
        if (url.endsWith(PROJECT_API_ROUTES.tasks.assign)) {
          expect(opts.body).toEqual({
            from: "user",
            to: "claude-1",
            assignee: "coder",
            tool: "claude",
            description: "Ship it",
            prompt: "Implement",
            type: "review",
            diff: "diff",
            worktreePath: "feature",
          });
          return { status: 200, json: { ok: true, task: { id: "task-2" }, thread: { id: "thread-3" } } };
        }
        if (url.endsWith(PROJECT_API_ROUTES.tasks.complete)) {
          expect(opts.body).toEqual({ taskId: "task-1", from: "claude-1", body: "done" });
          return { status: 200, json: { ok: true, task: { id: "task-1" }, thread: { id: "thread-1" } } };
        }
        if (url.endsWith(PROJECT_API_ROUTES.reviews.approve)) {
          expect(opts.body).toEqual({ taskId: "task-1", from: "reviewer", body: "ok" });
          return { status: 200, json: { ok: true, task: { id: "task-1" }, thread: { id: "thread-1" } } };
        }
        if (url.endsWith(PROJECT_API_ROUTES.reviews.requestChanges)) {
          expect(opts.body).toEqual({ taskId: "task-1", from: "reviewer", body: "fix" });
          return {
            status: 200,
            json: {
              ok: true,
              task: { id: "task-1" },
              followUpTask: { id: "task-3" },
              thread: { id: "thread-1" },
            },
          };
        }
        return { status: 200, json: projectServiceHealth(process.pid) };
      },
    );

    const listed = await daemon.routeRequest(
      "GET",
      `${CORE_API_ROUTES.taskListText}?project=${encodeURIComponent(projectRoot)}&session=claude-1&status=todo`,
    );
    const listedJson = await daemon.routeRequest(
      "GET",
      `${CORE_API_ROUTES.taskListText}?json=1&project=${encodeURIComponent(projectRoot)}&session=claude-1&status=todo`,
    );
    const shown = await daemon.routeRequest(
      "GET",
      `${CORE_API_ROUTES.taskShowText}?project=${encodeURIComponent(projectRoot)}&taskId=task-1`,
    );
    const handoff = await daemon.routeRequest("POST", CORE_API_ROUTES.handoffSendText, {
      project: projectRoot,
      body: "Take over",
      to: "claude-1",
      assignee: "coder",
      tool: "claude",
      title: "Handoff",
      worktree: "feature",
    });
    const accepted = await daemon.routeRequest("POST", CORE_API_ROUTES.handoffAcceptText, {
      project: projectRoot,
      threadId: "thread-2",
      from: "claude-1",
      body: "ok",
    });
    const assigned = await daemon.routeRequest("POST", CORE_API_ROUTES.taskAssignText, {
      project: projectRoot,
      description: "Ship it",
      to: "claude-1",
      assignee: "coder",
      tool: "claude",
      prompt: "Implement",
      type: "review",
      diff: "diff",
      worktree: "feature",
    });
    const completed = await daemon.routeRequest("POST", CORE_API_ROUTES.taskCompleteText, {
      project: projectRoot,
      taskId: "task-1",
      from: "claude-1",
      body: "done",
    });
    const approved = await daemon.routeRequest("POST", CORE_API_ROUTES.reviewApproveText, {
      project: projectRoot,
      taskId: "task-1",
      from: "reviewer",
      body: "ok",
    });
    const changes = await daemon.routeRequest("POST", CORE_API_ROUTES.reviewRequestChangesText, {
      project: projectRoot,
      taskId: "task-1",
      from: "reviewer",
      body: "fix",
    });
    const badHandoff = await daemon.routeRequest("POST", CORE_API_ROUTES.handoffSendText, {
      project: projectRoot,
      body: "No target",
    });

    expect(listed.body).toContain("task-1  task  todo  target=claude-1 thread=thread-1");
    expect(JSON.parse(String(listedJson.body))).toEqual({
      tasks: [
        expect.objectContaining({
          id: "task-1",
        }),
      ],
    });
    expect(shown.body).toContain("Ship it (task)");
    expect(handoff.body).toBe("thread thread-2\nmessage msg-2\ndelivered claude-1\n");
    expect(accepted.body).toBe("thread thread-2\nmessage msg-3\n");
    expect(assigned.body).toBe("task task-2\nthread thread-3\n");
    expect(completed.body).toBe("task task-1\nthread thread-1\n");
    expect(approved.body).toBe("task task-1\nthread thread-1\n");
    expect(changes.body).toBe("task task-1\nfollow-up task-3\nthread thread-1\n");
    expect(badHandoff.status).toBe(400);
    expect(badHandoff.body).toBe("aimux: handoff send requires --to, --assignee, or --tool\n");
  });

  it("serves remote enable text and rejects missing credentials for the installed shell shim", async () => {
    const { saveCredentials } = await import("./credentials.js");
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    const previousWebSocket = globalThis.WebSocket;
    class FakeWebSocket extends EventTarget {
      constructor(
        readonly url: string,
        readonly protocols: string[],
      ) {
        super();
      }

      close(): void {
        this.dispatchEvent(new Event("close"));
      }
    }

    const missing = await daemon.routeRequest("POST", CORE_API_ROUTES.remoteEnableText);

    expect(missing.status).toBe(401);
    expect(missing.body).toBe("Not logged in. Run `aimux login` first.\n");

    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    try {
      saveCredentials({
        version: 1,
        relayUrl: "wss://relay.example",
        token: "secret-token",
        userId: "user_123",
        createdAt: new Date().toISOString(),
        remoteEnabled: false,
      });
      const enabled = await daemon.routeRequest("POST", CORE_API_ROUTES.remoteEnableText);

      expect(enabled.status).toBe(200);
      expect(enabled.body).toBe("✓ Remote access enabled (connection: connecting)\n");
    } finally {
      globalThis.WebSocket = previousWebSocket;
    }
  });

  it("serves remote disable text for the installed shell shim", async () => {
    const { saveCredentials, loadCredentials } = await import("./credentials.js");
    const { AimuxDaemon } = await import("./daemon.js");
    saveCredentials({
      version: 1,
      relayUrl: "wss://relay.example",
      token: "secret-token",
      userId: "user_123",
      createdAt: new Date().toISOString(),
      remoteEnabled: true,
    });
    const daemon = new AimuxDaemon();

    const response = await daemon.routeRequest("POST", CORE_API_ROUTES.remoteDisableText);

    expect(response.status).toBe(200);
    expect(response.body).toBe("✓ Remote access disabled. Daemon disconnected from relay.\n");
    expect(loadCredentials()?.remoteEnabled).toBe(false);
  });

  it("clears stale metadata endpoints when core stops a legacy project service", async () => {
    const { AimuxDaemon } = await import("./daemon.js");

    const daemon = new AimuxDaemon();
    const legacyPid = 42_000;
    livePids.add(legacyPid);
    mkdirSync(join(tmpRoot, ".aimux", "projects", `proj-${basename(projectRoot)}`), { recursive: true });
    writeMetadataEndpointFor(legacyPid);
    (daemon as any).state.projects[`proj-${basename(projectRoot)}`] = {
      projectId: `proj-${basename(projectRoot)}`,
      projectRoot,
      pid: legacyPid,
      startedAt: STALE_SERVICE_TIMESTAMP,
      updatedAt: STALE_SERVICE_TIMESTAMP,
    };

    const response = await daemon.routeRequest("POST", CORE_API_ROUTES.commands, {
      command: CORE_COMMAND_NAMES.projectStop,
      payload: { projectRoot },
    });

    expect(response.status).toBe(200);
    expect(existsSync(join(tmpRoot, ".aimux", "projects", `proj-${basename(projectRoot)}`, "metadata-api.json"))).toBe(
      false,
    );
  });

  it("replaces a live project service when its health manifest is stale", async () => {
    const { AimuxDaemon } = await import("./daemon.js");

    const daemon = new AimuxDaemon();
    const first = await (daemon as any).ensureProject(projectRoot);
    mkdirSync(join(tmpRoot, ".aimux", "projects", `proj-${basename(projectRoot)}`), { recursive: true });
    writeMetadataEndpointFor(first.pid);
    mockProjectServiceHealth((pid) => ({
      status: 200,
      json:
        pid === first.pid
          ? projectServiceHealth(pid, { apiVersion: 4, capabilities: {}, buildStamp: "old-build" })
          : projectServiceHealth(pid),
    }));

    const second = await (daemon as any).ensureProject(projectRoot);

    expect(second.pid).toBe(first.pid);
    expect(coreActorMock.starts).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("replaces a live project service when health omits the manifest", async () => {
    const { AimuxDaemon } = await import("./daemon.js");

    const daemon = new AimuxDaemon();
    const first = await (daemon as any).ensureProject(projectRoot);
    mkdirSync(join(tmpRoot, ".aimux", "projects", `proj-${basename(projectRoot)}`), { recursive: true });
    writeMetadataEndpointFor(first.pid);
    mockProjectServiceHealth((pid) => ({
      status: 200,
      json: pid === first.pid ? { ok: true, pid } : projectServiceHealth(pid),
    }));

    const second = await (daemon as any).ensureProject(projectRoot);

    expect(second.pid).toBe(first.pid);
    expect(coreActorMock.starts).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("replaces a live project service when endpoint pid points elsewhere", async () => {
    const { AimuxDaemon } = await import("./daemon.js");

    const daemon = new AimuxDaemon();
    const first = await (daemon as any).ensureProject(projectRoot);
    (daemon as any).state.projects[`proj-${basename(projectRoot)}`].startedAt = STALE_SERVICE_TIMESTAMP;
    mkdirSync(join(tmpRoot, ".aimux", "projects", `proj-${basename(projectRoot)}`), { recursive: true });
    writeMetadataEndpointFor(first.pid + 1);

    const second = await (daemon as any).ensureProject(projectRoot);

    expect(second.pid).toBe(first.pid);
    expect(coreActorMock.starts).toHaveBeenCalledTimes(1);
    expect(vi.mocked(requestJson)).not.toHaveBeenCalled();
  });

  it("replaces a live project service when health pid points elsewhere", async () => {
    const { AimuxDaemon } = await import("./daemon.js");

    const daemon = new AimuxDaemon();
    const first = await (daemon as any).ensureProject(projectRoot);
    (daemon as any).state.projects[`proj-${basename(projectRoot)}`].startedAt = STALE_SERVICE_TIMESTAMP;
    mkdirSync(join(tmpRoot, ".aimux", "projects", `proj-${basename(projectRoot)}`), { recursive: true });
    writeMetadataEndpointFor(first.pid);
    mockProjectServiceHealth((pid) => ({
      status: 200,
      json: pid === first.pid ? projectServiceHealth(first.pid + 1) : projectServiceHealth(pid),
    }));

    const second = await (daemon as any).ensureProject(projectRoot);

    expect(second.pid).toBe(first.pid);
    expect(coreActorMock.starts).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("drops an unverified stale service pid without signaling it during replacement", async () => {
    execFileSyncMock.mockReturnValue("node unrelated-process.js");
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    const stalePid = 41_001;
    livePids.add(stalePid);
    (daemon as any).state.projects[`proj-${basename(projectRoot)}`] = {
      projectId: `proj-${basename(projectRoot)}`,
      projectRoot,
      pid: stalePid,
      startedAt: STALE_SERVICE_TIMESTAMP,
      updatedAt: STALE_SERVICE_TIMESTAMP,
    };
    mkdirSync(join(tmpRoot, ".aimux", "projects", `proj-${basename(projectRoot)}`), { recursive: true });
    writeMetadataEndpointFor(stalePid + 1);

    const replacement = await (daemon as any).ensureProject(projectRoot);

    expect(replacement.pid).not.toBe(stalePid);
    expect(process.kill).not.toHaveBeenCalledWith(stalePid, "SIGTERM");
    expect(process.kill).not.toHaveBeenCalledWith(stalePid, "SIGKILL");
  });

  it("kills a wedged legacy project service before starting the core actor", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    const stalePid = 41_002;
    livePids.add(stalePid);
    (daemon as any).state.projects[`proj-${basename(projectRoot)}`] = {
      projectId: `proj-${basename(projectRoot)}`,
      projectRoot,
      pid: stalePid,
      startedAt: STALE_SERVICE_TIMESTAMP,
      updatedAt: STALE_SERVICE_TIMESTAMP,
    };
    vi.mocked(process.kill).mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
      const numericPid = Number(pid);
      if (!livePids.has(numericPid)) throw new Error(`pid ${numericPid} is not alive`);
      if (signal === "SIGKILL") {
        livePids.delete(numericPid);
        childrenByPid.get(numericPid)?.emit("exit", 0, signal);
      }
      return true;
    }) as typeof process.kill);

    const replacement = await (daemon as any).ensureProject(projectRoot);

    expect(replacement.pid).toBe(process.pid);
    expect(process.kill).toHaveBeenCalledWith(stalePid, "SIGTERM");
    expect(process.kill).toHaveBeenCalledWith(stalePid, "SIGKILL");
    expect(coreActorMock.starts).toHaveBeenCalledTimes(1);
  });

  it("does not keep a failed project actor after startup fails", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    coreActorMock.failStartFor.add(projectRoot);

    await expect((daemon as any).ensureProject(projectRoot)).rejects.toThrow("actor start failed");
    expect(coreActorMock.stops).toHaveBeenCalledWith(projectRoot);

    coreActorMock.failStartFor.delete(projectRoot);
    const state = await (daemon as any).ensureProject(projectRoot);

    expect(state.pid).toBe(process.pid);
    expect(coreActorMock.starts).toHaveBeenCalledTimes(2);
  });

  it("respawns a dead project service on the next ensure call", async () => {
    const { AimuxDaemon } = await import("./daemon.js");

    const daemon = new AimuxDaemon();
    const first = await (daemon as any).ensureProject(projectRoot);
    livePids.delete(first.pid);

    const second = await (daemon as any).ensureProject(projectRoot);

    expect(second.pid).toBe(first.pid);
    expect(coreActorMock.starts).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("keeps a just-started live project service when its metadata endpoint is missing", async () => {
    const { AimuxDaemon } = await import("./daemon.js");

    const daemon = new AimuxDaemon();
    const first = await (daemon as any).ensureProject(projectRoot);

    const second = await (daemon as any).ensureProject(projectRoot);

    expect(second.pid).toBe(first.pid);
    expect(coreActorMock.starts).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("waits for a just-started project service to publish its metadata endpoint", async () => {
    const { AimuxDaemon } = await import("./daemon.js");

    const daemon = new AimuxDaemon();
    const first = await (daemon as any).ensureProject(projectRoot);
    rmSync(join(tmpRoot, ".aimux", "projects", `proj-${basename(projectRoot)}`, "metadata-api.json"), {
      force: true,
    });

    const second = await (daemon as any).ensureProject(projectRoot);

    expect(second.pid).toBe(first.pid);
    expect(coreActorMock.starts).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("waits for a repeatedly-unhealthy project service to exit before spawning a replacement", async () => {
    const { AimuxDaemon } = await import("./daemon.js");

    const daemon = new AimuxDaemon();
    const first = await (daemon as any).ensureProject(projectRoot);
    mkdirSync(join(tmpRoot, ".aimux", "projects", `proj-${basename(projectRoot)}`), { recursive: true });
    writeMetadataEndpointFor(first.pid);
    (daemon as any).state.projects[first.projectId].startedAt = new Date(Date.now() - 60_000).toISOString();
    mockProjectServiceHealth((pid) => {
      if (pid === first.pid) throw new Error("health failed");
      return {
        status: 200,
        json: projectServiceHealth(pid),
      };
    });

    vi.mocked(process.kill).mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
      const numericPid = Number(pid);
      if (!livePids.has(numericPid)) throw new Error(`pid ${numericPid} is not alive`);
      if (signal && signal !== 0) {
        setTimeout(() => {
          livePids.delete(numericPid);
          childrenByPid.get(numericPid)?.emit("exit", 0, signal);
        }, 25);
      }
      return true;
    }) as typeof process.kill);

    // Transient misses below the threshold are tolerated: the same service stays.
    expect((await (daemon as any).ensureProject(projectRoot)).pid).toBe(first.pid);
    expect((await (daemon as any).ensureProject(projectRoot)).pid).toBe(first.pid);
    expect(coreActorMock.starts).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();

    const replacementPromise = (daemon as any).ensureProject(projectRoot);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(coreActorMock.starts).toHaveBeenCalledTimes(1);

    const replacement = await replacementPromise;
    expect(replacement.pid).toBe(first.pid);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("serializes concurrent unhealthy project ensures into one replacement spawn", async () => {
    const { AimuxDaemon } = await import("./daemon.js");

    const daemon = new AimuxDaemon();
    const first = await (daemon as any).ensureProject(projectRoot);
    mkdirSync(join(tmpRoot, ".aimux", "projects", `proj-${basename(projectRoot)}`), { recursive: true });
    writeMetadataEndpointFor(first.pid);
    (daemon as any).state.projects[first.projectId].startedAt = new Date(Date.now() - 60_000).toISOString();
    mockProjectServiceHealth((pid) => {
      if (pid === first.pid) throw new Error("health failed");
      return {
        status: 200,
        json: projectServiceHealth(pid),
      };
    });

    // Two consecutive misses keep the failure counter just below the threshold.
    expect((await (daemon as any).ensureProject(projectRoot)).pid).toBe(first.pid);
    expect((await (daemon as any).ensureProject(projectRoot)).pid).toBe(first.pid);

    // Two concurrent ensures dedupe into one threshold-crossing health check,
    // producing a single replacement spawn shared by both callers.
    const [second, third] = await Promise.all([
      (daemon as any).ensureProject(projectRoot),
      (daemon as any).ensureProject(projectRoot),
    ]);

    expect(second.pid).toBe(third.pid);
    expect(second.pid).toBe(first.pid);
    expect(coreActorMock.starts).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("keeps dead services in daemon state so repair can rediscover the project", async () => {
    const daemonStatePath = join(tmpRoot, ".aimux", "daemon", "state.json");
    writeFileSync(
      daemonStatePath,
      JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        projects: {
          "proj-live": {
            projectId: "proj-live",
            projectRoot: "/tmp/live",
            pid: 30001,
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          "proj-dead": {
            projectId: "proj-dead",
            projectRoot: "/tmp/dead",
            pid: 30002,
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        },
      }),
    );
    livePids.add(30001);

    const { loadDaemonState } = await import("./daemon-state.js");
    const state = loadDaemonState();

    expect(Object.keys(state.projects)).toEqual(["proj-live", "proj-dead"]);
    const persisted = JSON.parse(readFileSync(daemonStatePath, "utf-8")) as { projects: Record<string, unknown> };
    expect(Object.keys(persisted.projects)).toEqual(["proj-live", "proj-dead"]);
  });

  it("stops child services when the daemon stops", async () => {
    const { AimuxDaemon } = await import("./daemon.js");

    const daemon = new AimuxDaemon();
    const project = await (daemon as any).ensureProject(projectRoot);
    const daemonInfoPath = join(tmpRoot, ".aimux", "daemon", "daemon.json");
    writeFileSync(
      daemonInfoPath,
      JSON.stringify({
        pid: 40001,
        port: 43190,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    livePids.add(40001);

    daemon.stop();

    expect(livePids.has(project.pid)).toBe(false);
    expect(readFileSync(daemonInfoPath, "utf-8")).toBe("");
  });

  it("does not signal unverified project service pids when the daemon instance stops", async () => {
    execFileSyncMock.mockReturnValue("node unrelated-process.js");
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    const stalePid = 42_001;
    livePids.add(stalePid);
    (daemon as any).state.projects[`proj-${basename(projectRoot)}`] = {
      projectId: `proj-${basename(projectRoot)}`,
      projectRoot,
      pid: stalePid,
      startedAt: STALE_SERVICE_TIMESTAMP,
      updatedAt: STALE_SERVICE_TIMESTAMP,
    };

    daemon.stop();

    expect(process.kill).not.toHaveBeenCalledWith(stalePid, "SIGTERM");
  });

  it("starts in-process project actors when logging is enabled", async () => {
    configureLogging({
      enabled: true,
      level: "debug",
      categories: ["daemon", "session"],
      maxBytes: 100_000,
      maxFiles: 2,
      path: join(tmpRoot, ".aimux", "projects", "global", "logs", "aimux.jsonl"),
      processKind: "test",
    });
    const { AimuxDaemon } = await import("./daemon.js");

    const daemon = new AimuxDaemon();
    const project = await (daemon as any).ensureProject(projectRoot);

    expect(project.pid).toBe(process.pid);
    expect(coreActorMock.starts).toHaveBeenCalledWith(projectRoot);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("reads daemon host and port from environment overrides", async () => {
    const previousHost = process.env.AIMUX_DAEMON_HOST;
    const previousPort = process.env.AIMUX_DAEMON_PORT;
    try {
      process.env.AIMUX_DAEMON_HOST = "localhost";
      process.env.AIMUX_DAEMON_PORT = "44191";
      const { getDaemonHost, getDaemonPort } = await import("./daemon-state.js");

      expect(getDaemonHost()).toBe("localhost");
      expect(getDaemonPort()).toBe(44191);
    } finally {
      if (previousHost === undefined) {
        delete process.env.AIMUX_DAEMON_HOST;
      } else {
        process.env.AIMUX_DAEMON_HOST = previousHost;
      }
      if (previousPort === undefined) {
        delete process.env.AIMUX_DAEMON_PORT;
      } else {
        process.env.AIMUX_DAEMON_PORT = previousPort;
      }
    }
  });

  it("rejects daemon host overrides that bind outside loopback", async () => {
    const previousHost = process.env.AIMUX_DAEMON_HOST;
    try {
      process.env.AIMUX_DAEMON_HOST = "0.0.0.0";
      const { getDaemonHost } = await import("./daemon-state.js");

      expect(() => getDaemonHost()).toThrow(/must be loopback/);
    } finally {
      if (previousHost === undefined) {
        delete process.env.AIMUX_DAEMON_HOST;
      } else {
        process.env.AIMUX_DAEMON_HOST = previousHost;
      }
    }
  });

  it("probes the configured daemon port when adopting an existing daemon", async () => {
    const previousPort = process.env.AIMUX_DAEMON_PORT;
    try {
      process.env.AIMUX_DAEMON_PORT = "44191";
      vi.mocked(requestJson).mockResolvedValueOnce({
        status: 200,
        json: daemonHealth(50_001, 44191),
      });
      const { ensureDaemonRunning } = await import("./daemon-supervisor.js");

      const info = await ensureDaemonRunning();

      expect(info.port).toBe(44191);
      expect(vi.mocked(requestJson)).toHaveBeenCalledWith("http://127.0.0.1:44191/health", {
        timeoutMs: 2500,
      });
    } finally {
      if (previousPort === undefined) {
        delete process.env.AIMUX_DAEMON_PORT;
      } else {
        process.env.AIMUX_DAEMON_PORT = previousPort;
      }
    }
  });

  it("does not adopt stored daemon info for a different live pid", async () => {
    const previousPort = process.env.AIMUX_DAEMON_PORT;
    try {
      process.env.AIMUX_DAEMON_PORT = "44191";
      mkdirSync(join(tmpRoot, ".aimux", "daemon"), { recursive: true });
      writeFileSync(
        join(tmpRoot, ".aimux", "daemon", "daemon.json"),
        JSON.stringify({ pid: 111, port: 44191, startedAt: "then", updatedAt: "then" }),
      );
      vi.mocked(requestJson)
        .mockResolvedValueOnce({ status: 200, json: daemonHealth(222, 44191) })
        .mockResolvedValueOnce({ status: 200, json: daemonHealth(222, 44191) });
      const { ensureDaemonRunning } = await import("./daemon-supervisor.js");

      const info = await ensureDaemonRunning();

      expect(info.pid).toBe(222);
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      if (previousPort === undefined) {
        delete process.env.AIMUX_DAEMON_PORT;
      } else {
        process.env.AIMUX_DAEMON_PORT = previousPort;
      }
    }
  });

  it("does not terminate a default-port process without Aimux daemon identity", async () => {
    const previousPort = process.env.AIMUX_DAEMON_PORT;
    try {
      process.env.AIMUX_DAEMON_PORT = "44191";
      livePids.add(50_001);
      vi.mocked(requestJson)
        .mockResolvedValueOnce({ status: 200, json: { ok: true, pid: 50_001, port: 44191 } })
        .mockResolvedValueOnce({ status: 200, json: daemonHealth(20_000, 44191) });
      spawnMock.mockImplementationOnce(() => {
        const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
        child.pid = 20_000;
        child.unref = () => {};
        livePids.add(child.pid);
        childrenByPid.set(child.pid, child);
        writeFileSync(
          join(tmpRoot, ".aimux", "daemon", "daemon.json"),
          JSON.stringify({ pid: child.pid, port: 44191, startedAt: "after", updatedAt: "after" }),
        );
        return child;
      });
      const { ensureDaemonRunning } = await import("./daemon-supervisor.js");

      const info = await ensureDaemonRunning({ adoptExisting: false });

      expect(info.pid).toBe(20_000);
      expect(process.kill).not.toHaveBeenCalledWith(50_001, "SIGTERM");
      expect(spawnMock).toHaveBeenCalled();
    } finally {
      if (previousPort === undefined) {
        delete process.env.AIMUX_DAEMON_PORT;
      } else {
        process.env.AIMUX_DAEMON_PORT = previousPort;
      }
    }
  });

  it("waits for spawned daemon health to match the written daemon info", async () => {
    const previousPort = process.env.AIMUX_DAEMON_PORT;
    try {
      process.env.AIMUX_DAEMON_PORT = "44191";
      vi.mocked(requestJson)
        .mockRejectedValueOnce(new Error("no daemon yet"))
        .mockResolvedValueOnce({ status: 200, json: daemonHealth(99_999, 44191) })
        .mockResolvedValueOnce({ status: 200, json: daemonHealth(20_000, 44191) });
      spawnMock.mockImplementationOnce(() => {
        const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
        child.pid = 20_000;
        child.unref = () => {};
        livePids.add(child.pid);
        childrenByPid.set(child.pid, child);
        writeFileSync(
          join(tmpRoot, ".aimux", "daemon", "daemon.json"),
          JSON.stringify({ pid: child.pid, port: 44191, startedAt: "after", updatedAt: "after" }),
        );
        return child;
      });
      const { ensureDaemonRunning } = await import("./daemon-supervisor.js");

      const info = await ensureDaemonRunning({ adoptExisting: false });

      expect(info.pid).toBe(20_000);
      expect(vi.mocked(requestJson)).toHaveBeenCalledTimes(3);
    } finally {
      if (previousPort === undefined) {
        delete process.env.AIMUX_DAEMON_PORT;
      } else {
        process.env.AIMUX_DAEMON_PORT = previousPort;
      }
    }
  });

  it("terminates an identified stale-build daemon on restart", async () => {
    const previousPort = process.env.AIMUX_DAEMON_PORT;
    try {
      process.env.AIMUX_DAEMON_PORT = "44191";
      livePids.add(50_001);
      vi.mocked(requestJson)
        .mockResolvedValueOnce({ status: 200, json: staleDaemonHealth(50_001, 44191) })
        .mockResolvedValueOnce({ status: 200, json: daemonHealth(20_000, 44191) });
      spawnMock.mockImplementationOnce(() => {
        const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
        child.pid = 20_000;
        child.unref = () => {};
        livePids.add(child.pid);
        childrenByPid.set(child.pid, child);
        writeFileSync(
          join(tmpRoot, ".aimux", "daemon", "daemon.json"),
          JSON.stringify({ pid: child.pid, port: 44191, startedAt: "after", updatedAt: "after" }),
        );
        return child;
      });
      const { ensureDaemonRunning } = await import("./daemon-supervisor.js");

      const info = await ensureDaemonRunning({ adoptExisting: false });

      expect(info.pid).toBe(20_000);
      expect(process.kill).toHaveBeenCalledWith(50_001, "SIGTERM");
    } finally {
      if (previousPort === undefined) {
        delete process.env.AIMUX_DAEMON_PORT;
      } else {
        process.env.AIMUX_DAEMON_PORT = previousPort;
      }
    }
  });

  it("does not adopt an identified stale-build daemon by default", async () => {
    const previousPort = process.env.AIMUX_DAEMON_PORT;
    try {
      process.env.AIMUX_DAEMON_PORT = "44191";
      livePids.add(50_001);
      vi.mocked(requestJson).mockResolvedValueOnce({ status: 200, json: staleDaemonHealth(50_001, 44191) });
      const { ensureDaemonRunning } = await import("./daemon-supervisor.js");

      await expect(ensureDaemonRunning()).rejects.toThrow("different local build");

      expect(process.kill).not.toHaveBeenCalledWith(50_001, "SIGTERM");
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      if (previousPort === undefined) {
        delete process.env.AIMUX_DAEMON_PORT;
      } else {
        process.env.AIMUX_DAEMON_PORT = previousPort;
      }
    }
  });

  it("does not signal unverified project service pids while stopping the daemon", async () => {
    execFileSyncMock.mockReturnValue("node unrelated-process.js");
    const { stopDaemon } = await import("./daemon-supervisor.js");
    mkdirSync(join(tmpRoot, ".aimux", "daemon"), { recursive: true });
    livePids.add(50_001);
    livePids.add(50_002);
    writeFileSync(
      join(tmpRoot, ".aimux", "daemon", "daemon.json"),
      JSON.stringify({ pid: 50_001, port: 43190, startedAt: "then", updatedAt: "then" }),
    );
    writeFileSync(
      join(tmpRoot, ".aimux", "daemon", "state.json"),
      JSON.stringify({
        version: 1,
        updatedAt: "then",
        projects: {
          repo: {
            projectId: "repo",
            projectRoot,
            pid: 50_002,
            startedAt: "then",
            updatedAt: "then",
          },
        },
      }),
    );

    const stopped = await stopDaemon();

    expect(stopped?.stoppedProjectServices).toEqual([]);
    expect(process.kill).not.toHaveBeenCalledWith(50_002, "SIGTERM");
    expect(process.kill).toHaveBeenCalledWith(50_001, "SIGTERM");
  });

  it("accepts legacy project service pids only when cwd matches the project", async () => {
    const { stopDaemon } = await import("./daemon-supervisor.js");
    mkdirSync(join(tmpRoot, ".aimux", "daemon"), { recursive: true });
    livePids.add(50_001);
    livePids.add(50_002);
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "lsof") return `p${args[2]}\nfcwd\nn${projectRoot}\n`;
      return "node /opt/aimux/dist/main.js __project-service-internal";
    });
    writeFileSync(
      join(tmpRoot, ".aimux", "daemon", "daemon.json"),
      JSON.stringify({ pid: 50_001, port: 43190, startedAt: "then", updatedAt: "then" }),
    );
    writeFileSync(
      join(tmpRoot, ".aimux", "daemon", "state.json"),
      JSON.stringify({
        version: 1,
        updatedAt: "then",
        projects: {
          [`proj-${basename(projectRoot)}`]: {
            projectId: `proj-${basename(projectRoot)}`,
            projectRoot,
            pid: 50_002,
            startedAt: "then",
            updatedAt: "then",
          },
        },
      }),
    );

    const stopped = await stopDaemon();

    expect(stopped?.stoppedProjectServices.map((service) => service.pid)).toEqual([50_002]);
    expect(process.kill).toHaveBeenCalledWith(50_002, "SIGTERM");
  });

  it("does not signal project service pids whose project root only prefix-matches", async () => {
    const { stopDaemon } = await import("./daemon-supervisor.js");
    mkdirSync(join(tmpRoot, ".aimux", "daemon"), { recursive: true });
    livePids.add(50_001);
    livePids.add(50_002);
    execFileSyncMock.mockReturnValue(`${currentProjectServiceArgs(projectRoot)}-old`);
    writeFileSync(
      join(tmpRoot, ".aimux", "daemon", "daemon.json"),
      JSON.stringify({ pid: 50_001, port: 43190, startedAt: "then", updatedAt: "then" }),
    );
    writeFileSync(
      join(tmpRoot, ".aimux", "daemon", "state.json"),
      JSON.stringify({
        version: 1,
        updatedAt: "then",
        projects: {
          [`proj-${basename(projectRoot)}`]: {
            projectId: `proj-${basename(projectRoot)}`,
            projectRoot,
            pid: 50_002,
            startedAt: "then",
            updatedAt: "then",
          },
        },
      }),
    );

    const stopped = await stopDaemon();

    expect(stopped?.stoppedProjectServices).toEqual([]);
    expect(process.kill).not.toHaveBeenCalledWith(50_002, "SIGTERM");
  });

  it("does not signal unverified project service pids for /projects/stop", async () => {
    execFileSyncMock.mockReturnValue("node unrelated-process.js");
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    const stalePid = 43_001;
    livePids.add(stalePid);
    (daemon as any).state.projects[`proj-${basename(projectRoot)}`] = {
      projectId: `proj-${basename(projectRoot)}`,
      projectRoot,
      pid: stalePid,
      startedAt: STALE_SERVICE_TIMESTAMP,
      updatedAt: STALE_SERVICE_TIMESTAMP,
    };

    const res = await daemon.routeRequest("POST", "/projects/stop", { projectRoot });

    expect(res.status).toBe(200);
    expect(process.kill).not.toHaveBeenCalledWith(stalePid, "SIGTERM");
  });
});

describe("daemon routing (relay + proxy)", () => {
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "aimux-daemon-routes-"));
    projectRoot = join(tmpRoot, "project");
    mkdirSync(projectRoot, { recursive: true });
    livePids = new Set();
    childrenByPid = new Map();
    nextPid = 30_000;
    spawnMock.mockReset();
    coreActorMock.starts.mockReset();
    coreActorMock.stops.mockReset();
    coreActorMock.kills.mockReset();
    coreActorMock.instances.length = 0;
    execFileSyncMock.mockReset();
    vi.mocked(requestJson).mockReset();
    mockHealthyRequests();

    spawnMock.mockImplementation(() => {
      const pid = nextPid++;
      const child = new EventEmitter() as EventEmitter & { pid: number; kill: (sig?: string) => boolean };
      child.pid = pid;
      child.kill = () => {
        livePids.delete(pid);
        setImmediate(() => child.emit("exit", 0, null));
        return true;
      };
      livePids.add(pid);
      childrenByPid.set(pid, child);
      mkdirSync(join(tmpRoot, ".aimux", "projects", `proj-${basename(projectRoot)}`), { recursive: true });
      writeMetadataEndpointFor(pid);
      return child;
    });
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
      const numericPid = Number(pid);
      if (!livePids.has(numericPid)) {
        throw new Error(`pid ${numericPid} is not alive`);
      }
      if (signal && signal !== 0) {
        livePids.delete(numericPid);
        childrenByPid.get(numericPid)?.emit("exit", 0, signal);
      }
      return true;
    }) as typeof process.kill);
  });

  afterEach(() => {
    vi.mocked(requestJson).mockReset();
    vi.mocked(requestJson).mockResolvedValue({ status: 200, json: { ok: true } });
    vi.restoreAllMocks();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("reports relay status as off when no relay is configured", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();

    const res = await daemon.routeRequest("GET", "/relay/status");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, relay: { status: "off" } });
  });

  it("reloads stored relay credentials when relay is enabled again", async () => {
    const previousWebSocket = globalThis.WebSocket;
    const sockets: Array<{ url: string; protocols: string[]; closed: boolean }> = [];
    class FakeWebSocket extends EventTarget {
      closed = false;

      constructor(
        readonly url: string,
        readonly protocols: string[],
      ) {
        super();
        sockets.push(this);
      }

      close(): void {
        this.closed = true;
      }
    }

    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    try {
      const { saveCredentials } = await import("./credentials.js");
      const { AimuxDaemon } = await import("./daemon.js");
      const daemon = new AimuxDaemon();
      const baseCredentials = {
        version: 1 as const,
        relayUrl: "wss://relay.example",
        userId: "user_123",
        createdAt: new Date().toISOString(),
        remoteEnabled: true,
      };

      saveCredentials({ ...baseCredentials, token: "old-token" });
      const first = daemon.enableRelay();

      saveCredentials({ ...baseCredentials, token: "new-token" });
      const second = daemon.enableRelay();

      expect(first.status).toBe("connecting");
      expect(second.status).toBe("connecting");
      expect(sockets).toHaveLength(2);
      expect(sockets[0]).toMatchObject({
        url: "wss://relay.example/daemon/connect",
        protocols: ["aimux", "aimux-token.old-token"],
        closed: true,
      });
      expect(sockets[1]).toMatchObject({
        url: "wss://relay.example/daemon/connect",
        protocols: ["aimux", "aimux-token.new-token"],
        closed: false,
      });
    } finally {
      globalThis.WebSocket = previousWebSocket;
    }
  });

  it("rejects /proxy requests to non-loopback hosts with 403", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();

    const res = await daemon.routeRequest("GET", "/proxy/evil.example.com/8080/health");

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ ok: false });
    expect(vi.mocked(requestJson)).not.toHaveBeenCalled();
  });

  it("forwards /proxy requests for loopback hosts and propagates timeoutMs", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();

    const res = await daemon.routeRequest("GET", "/proxy/127.0.0.1/4321/state");

    expect(res.status).toBe(200);
    expect(vi.mocked(requestJson)).toHaveBeenCalledWith(
      "http://127.0.0.1:4321/state",
      expect.objectContaining({ method: "GET", timeoutMs: expect.any(Number) }),
    );
  });

  it("blocks shared guest relay requests from mutating daemon or project state", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    const headers = {
      "x-aimux-actor-role": "guest",
      "x-aimux-share-id": "share_1",
      "x-aimux-share-session-id": "claude-1",
    };

    const daemonMutation = await daemon.routeRequest("POST", "/projects/ensure", { projectRoot }, headers);
    const projectMutation = await daemon.routeRequest(
      "POST",
      "/proxy/127.0.0.1/4321/agents/stop",
      { sessionId: "claude-1" },
      headers,
    );
    const otherSessionRead = await daemon.routeRequest(
      "GET",
      "/proxy/127.0.0.1/4321/agents/output?sessionId=claude-2",
      undefined,
      headers,
    );
    const unscopedSessionRead = await daemon.routeRequest(
      "GET",
      "/proxy/127.0.0.1/4321/agents/output?sessionId=claude-1",
      undefined,
      { "x-aimux-actor-role": "guest", "x-aimux-share-id": "share_1" },
    );
    const attachmentRead = await daemon.routeRequest(
      "GET",
      "/proxy/127.0.0.1/4321/attachments/att_1/content",
      undefined,
      headers,
    );
    expect(daemonMutation.status).toBe(403);
    expect(projectMutation.status).toBe(403);
    expect(otherSessionRead.status).toBe(403);
    expect(unscopedSessionRead.status).toBe(403);
    expect(attachmentRead.status).toBe(403);
    expect(vi.mocked(requestJson)).not.toHaveBeenCalled();
  });

  it("allows shared guest relay requests to read the authorized session output", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();

    const res = await daemon.routeRequest("GET", "/proxy/127.0.0.1/4321/agents/output?sessionId=claude-1", undefined, {
      "x-aimux-actor-role": "guest",
      "x-aimux-share-id": "share_1",
      "x-aimux-share-session-id": "claude-1",
    });

    expect(res.status).toBe(200);
    expect(vi.mocked(requestJson)).toHaveBeenCalledWith(
      "http://127.0.0.1:4321/agents/output?sessionId=claude-1",
      expect.objectContaining({ method: "GET", timeoutMs: expect.any(Number) }),
    );
  });

  it("allows shared guest relay requests to read canonical live pane output", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();

    const res = await daemon.routeRequest(
      "GET",
      "/proxy/127.0.0.1/4321/live-pane/output?sessionId=claude-1",
      undefined,
      {
        "x-aimux-actor-role": "guest",
        "x-aimux-share-id": "share_1",
        "x-aimux-share-session-id": "claude-1",
      },
    );

    expect(res.status).toBe(200);
    expect(vi.mocked(requestJson)).toHaveBeenCalledWith(
      "http://127.0.0.1:4321/live-pane/output?sessionId=claude-1",
      expect.objectContaining({ method: "GET", timeoutMs: expect.any(Number) }),
    );
  });

  it("resolves authorized shared guest project event streams", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();

    const res = daemon.resolveProjectEventStream("/proxy/127.0.0.1/4321/events?sessionId=claude-1", {
      "x-aimux-actor-role": "guest",
      "x-aimux-share-id": "share_1",
      "x-aimux-share-session-id": "claude-1",
    });

    expect(res).toEqual({
      ok: true,
      url: "http://127.0.0.1:4321/events?sessionId=claude-1",
      headers: {
        "x-aimux-actor-role": "guest",
        "x-aimux-share-id": "share_1",
        "x-aimux-share-session-id": "claude-1",
      },
    });
  });

  it("rejects unscoped shared guest project event streams", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();

    const res = daemon.resolveProjectEventStream("/proxy/127.0.0.1/4321/events", {
      "x-aimux-actor-role": "guest",
      "x-aimux-share-id": "share_1",
      "x-aimux-share-session-id": "claude-1",
    });

    expect(res).toMatchObject({
      ok: false,
      status: 403,
      error: "shared session route requires a session id",
    });
  });

  it("returns 504 when the proxied target times out", async () => {
    vi.mocked(requestJson).mockRejectedValueOnce(new Error("request timed out after 10000ms"));
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();

    const res = await daemon.routeRequest("GET", "/proxy/127.0.0.1/4321/slow");

    expect(res.status).toBe(504);
    expect(res.body).toMatchObject({ ok: false });
  });

  it("does not report retained unverified project records as live services", async () => {
    execFileSyncMock.mockReturnValue("node unrelated-process.js");
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    const retainedPid = 43_101;
    livePids.add(retainedPid);
    mkdirSync(join(tmpRoot, ".aimux", "projects", `proj-${basename(projectRoot)}`), { recursive: true });
    writeMetadataEndpointFor(retainedPid);
    (daemon as any).state.projects[`proj-${basename(projectRoot)}`] = {
      projectId: `proj-${basename(projectRoot)}`,
      projectRoot,
      pid: retainedPid,
      startedAt: STALE_SERVICE_TIMESTAMP,
      updatedAt: STALE_SERVICE_TIMESTAMP,
    };

    const res = await daemon.routeRequest("GET", "/projects");

    expect(res.status).toBe(200);
    const [project] = (res.body as any).projects;
    expect(project.serviceAlive).toBe(false);
    expect(project.service).toBeNull();
  });

  it("does not report retained legacy project records as live services", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    const retainedPid = 43_102;
    livePids.add(retainedPid);
    mkdirSync(join(tmpRoot, ".aimux", "projects", `proj-${basename(projectRoot)}`), { recursive: true });
    writeMetadataEndpointFor(retainedPid);
    execFileSyncMock.mockReturnValue(currentProjectServiceArgs(projectRoot));
    (daemon as any).state.projects[`proj-${basename(projectRoot)}`] = {
      projectId: `proj-${basename(projectRoot)}`,
      projectRoot,
      pid: retainedPid,
      startedAt: STALE_SERVICE_TIMESTAMP,
      updatedAt: STALE_SERVICE_TIMESTAMP,
    };

    const res = await daemon.routeRequest("GET", "/projects");

    expect(res.status).toBe(200);
    const [project] = (res.body as any).projects;
    expect(project.serviceAlive).toBe(false);
    expect(project.service).toBeNull();
  });

  it("does not verify retained legacy project records during project list polling", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    const retainedPid = 43_103;
    livePids.add(retainedPid);
    mkdirSync(join(tmpRoot, ".aimux", "projects", `proj-${basename(projectRoot)}`), { recursive: true });
    writeMetadataEndpointFor(retainedPid);
    execFileSyncMock.mockReturnValue(currentProjectServiceArgs(projectRoot));
    (daemon as any).state.projects[`proj-${basename(projectRoot)}`] = {
      projectId: `proj-${basename(projectRoot)}`,
      projectRoot,
      pid: retainedPid,
      startedAt: STALE_SERVICE_TIMESTAMP,
      updatedAt: STALE_SERVICE_TIMESTAMP,
    };

    execFileSyncMock.mockClear();
    await daemon.routeRequest("GET", "/projects");
    await daemon.routeRequest("GET", "/projects");

    const psCalls = execFileSyncMock.mock.calls.filter(([cmd]) => cmd === "ps");
    expect(psCalls).toHaveLength(0);
  });

  it("keeps retained legacy project records non-live when the pid exits", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    const retainedPid = 43_104;
    livePids.add(retainedPid);
    mkdirSync(join(tmpRoot, ".aimux", "projects", `proj-${basename(projectRoot)}`), { recursive: true });
    writeMetadataEndpointFor(retainedPid);
    execFileSyncMock.mockReturnValue(currentProjectServiceArgs(projectRoot));
    (daemon as any).state.projects[`proj-${basename(projectRoot)}`] = {
      projectId: `proj-${basename(projectRoot)}`,
      projectRoot,
      pid: retainedPid,
      startedAt: STALE_SERVICE_TIMESTAMP,
      updatedAt: STALE_SERVICE_TIMESTAMP,
    };

    const first = await daemon.routeRequest("GET", "/projects");
    livePids.delete(retainedPid);
    const second = await daemon.routeRequest("GET", "/projects");

    expect((first.body as any).projects[0].serviceAlive).toBe(false);
    expect((first.body as any).projects[0].service).toBeNull();
    expect((second.body as any).projects[0].serviceAlive).toBe(false);
    expect((second.body as any).projects[0].service).toBeNull();
  });

  it("reflects registered project list changes on the next project list read", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();

    const first = await daemon.routeRequest("GET", "/projects");
    const nextRoot = join(tmpRoot, "repo-two");
    mkdirSync(nextRoot, { recursive: true });
    projectRoot = nextRoot;
    const second = await daemon.routeRequest("GET", "/projects");

    expect((first.body as any).projects[0].path).not.toBe(nextRoot);
    expect((second.body as any).projects[0].path).toBe(nextRoot);
    expect((second.body as any).projects[0].id).toBe("proj-repo-two");
  });

  it("reports ensured project services on the next project list read", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();

    const before = await daemon.routeRequest("GET", "/projects");
    expect((before.body as any).projects[0].serviceAlive).toBe(false);

    const ensured = await daemon.routeRequest("POST", "/projects/ensure", { projectRoot });
    expect(ensured.status).toBe(200);

    const after = await daemon.routeRequest("GET", "/projects");
    expect((after.body as any).projects[0].serviceAlive).toBe(true);
    expect((after.body as any).projects[0].service).toMatchObject({ pid: process.pid });
  });

  it("allows browser preflight requests to daemon routes", async () => {
    const originalPort = process.env.AIMUX_DAEMON_PORT;
    const port = "49191";
    process.env.AIMUX_DAEMON_PORT = port;
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();

    try {
      await daemon.start();

      const res = await fetch(`http://127.0.0.1:${port}/projects`, {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:8081",
          "Access-Control-Request-Method": "GET",
        },
      });

      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:8081");
      expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    } finally {
      daemon.stop();
      if (originalPort === undefined) {
        delete process.env.AIMUX_DAEMON_PORT;
      } else {
        process.env.AIMUX_DAEMON_PORT = originalPort;
      }
    }
  });

  it("allows browser preflight requests from the parallel dev web port", async () => {
    const originalPort = process.env.AIMUX_DAEMON_PORT;
    const port = "49193";
    process.env.AIMUX_DAEMON_PORT = port;
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();

    try {
      await daemon.start();

      const res = await fetch(`http://127.0.0.1:${port}/projects`, {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:8091",
          "Access-Control-Request-Method": "GET",
        },
      });

      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:8091");
      expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    } finally {
      daemon.stop();
      if (originalPort === undefined) {
        delete process.env.AIMUX_DAEMON_PORT;
      } else {
        process.env.AIMUX_DAEMON_PORT = originalPort;
      }
    }
  });

  it("rejects browser-origin core text route requests", async () => {
    const originalPort = process.env.AIMUX_DAEMON_PORT;
    const port = "49194";
    process.env.AIMUX_DAEMON_PORT = port;
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();

    try {
      await daemon.start();

      const res = await fetch(`http://127.0.0.1:${port}${CORE_API_ROUTES.lifecycleSpawnText}`, {
        method: "POST",
        headers: {
          Origin: "http://localhost:8081",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ project: projectRoot, tool: "claude" }),
      });

      expect(res.status).toBe(403);
      expect(await res.text()).toBe("core text routes are cli-only\n");

      const metadataRes = await fetch(`http://127.0.0.1:${port}${CORE_API_ROUTES.metadataText}`, {
        method: "POST",
        headers: { Origin: "http://localhost:8081" },
      });

      expect(metadataRes.status).toBe(403);
      expect(await metadataRes.text()).toBe("core text routes are cli-only\n");

      const restartRes = await fetch(`http://127.0.0.1:${port}${CORE_API_ROUTES.restartText}`, {
        method: "POST",
        headers: { Origin: "http://localhost:8081" },
      });

      expect(restartRes.status).toBe(403);
      expect(await restartRes.text()).toBe("core text routes are cli-only\n");

      const getRes = await fetch(
        `http://127.0.0.1:${port}${CORE_API_ROUTES.worktreeListText}?project=${encodeURIComponent(projectRoot)}`,
        { headers: { Origin: "http://localhost:8081" } },
      );

      expect(getRes.status).toBe(403);
      expect(await getRes.text()).toBe("core text routes are cli-only\n");
      expect(coreActorMock.starts).not.toHaveBeenCalled();
    } finally {
      daemon.stop();
      if (originalPort === undefined) {
        delete process.env.AIMUX_DAEMON_PORT;
      } else {
        process.env.AIMUX_DAEMON_PORT = originalPort;
      }
    }
  });

  it("rejects browser requests from disallowed origins", async () => {
    const originalPort = process.env.AIMUX_DAEMON_PORT;
    const port = "49192";
    process.env.AIMUX_DAEMON_PORT = port;
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();

    try {
      await daemon.start();

      const preflight = await fetch(`http://127.0.0.1:${port}/projects`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://example.com",
          "Access-Control-Request-Method": "GET",
        },
      });
      const actual = await fetch(`http://127.0.0.1:${port}/projects`, {
        headers: { Origin: "https://example.com" },
      });

      expect(preflight.status).toBe(403);
      expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
      expect(actual.status).toBe(403);
      expect(actual.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      daemon.stop();
      if (originalPort === undefined) {
        delete process.env.AIMUX_DAEMON_PORT;
      } else {
        process.env.AIMUX_DAEMON_PORT = originalPort;
      }
    }
  });
});
