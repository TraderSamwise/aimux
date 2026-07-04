import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestJson } from "./http-client.js";
import { configureLogging, resetLoggingForTests } from "./debug.js";
import { getProjectServiceManifest } from "./project-service-manifest.js";
import { CORE_API_ROUTES, CORE_COMMAND_NAMES, type CoreCommandOk } from "./core-command-contract.js";
import { getProjectIdFor } from "./paths.js";

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

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

vi.mock("./paths.js", () => ({
  getGlobalAimuxDir: () => join(tmpRoot, ".aimux"),
  getDaemonInfoPath: () => join(tmpRoot, ".aimux", "daemon", "daemon.json"),
  getDaemonStatePath: () => join(tmpRoot, ".aimux", "daemon", "state.json"),
  getDaemonStdioLogPath: () => join(tmpRoot, ".aimux", "daemon", "logs", "daemon-stdio.log"),
  getAuthPath: () => join(tmpRoot, ".aimux", "auth.json"),
  getProjectStateDir: () => join(tmpRoot, ".aimux", "projects", "global"),
  getProjectStateDirFor: (cwd: string) => join(tmpRoot, ".aimux", "projects", `proj-${basename(cwd)}`),
  getProjectStateDirById: (projectId: string) => join(tmpRoot, ".aimux", "projects", projectId),
  getProjectIdFor: (cwd: string) => `proj-${basename(cwd)}`,
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

function writeMetadataEndpointFor(pid: number) {
  writeFileSync(
    join(tmpRoot, ".aimux", "projects", `proj-${basename(projectRoot)}`, "metadata-api.json"),
    JSON.stringify({
      host: "127.0.0.1",
      port: 44291,
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

  it("runs control-plane restart through daemon-owned project actors", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    runtimeRestartMock.restartAimuxControlPlane.mockImplementationOnce(async (options: any) => {
      expect(await options.stopDaemon()).toBeNull();
      expect(options.isAimuxProjectServiceProcess(41_000, { projectRoot })).toBe(false);
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
