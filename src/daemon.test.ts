import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestJson } from "./http-client.js";
import { configureLogging, resetLoggingForTests } from "./debug.js";
import { getProjectServiceManifest } from "./project-service-manifest.js";

let tmpRoot = "";
let projectRoot = "";
let nextPid = 20_000;
let livePids = new Set<number>();
let childrenByPid = new Map<number, EventEmitter>();
const spawnMock = vi.fn();
const execFileSyncMock = vi.fn();
const STALE_SERVICE_TIMESTAMP = new Date(0).toISOString();

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
  getProjectServiceStdioLogPathFor: (cwd: string) =>
    join(tmpRoot, ".aimux", "projects", `proj-${basename(cwd)}`, "logs", "project-service-stdio.log"),
}));

vi.mock("./project-scanner.js", () => ({
  listDesktopProjects: () => listMockDesktopProjects(),
  listRegisteredDesktopProjects: () => listMockDesktopProjects(),
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
    execFileSyncMock.mockReset();
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "lsof") return `p${args[2]}\nfcwd\nn${projectRoot}\n`;
      return `node /opt/aimux/dist/main.js __project-service-internal --project-id proj-${basename(
        projectRoot,
      )} --project-root ${projectRoot}`;
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
    expect(spawnMock).toHaveBeenCalledTimes(1);
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

    expect(second.pid).not.toBe(first.pid);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(livePids.has(first.pid)).toBe(false);
    expect(livePids.has(second.pid)).toBe(true);
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

    expect(second.pid).not.toBe(first.pid);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("replaces a live project service when endpoint pid points elsewhere", async () => {
    const { AimuxDaemon } = await import("./daemon.js");

    const daemon = new AimuxDaemon();
    const first = await (daemon as any).ensureProject(projectRoot);
    (daemon as any).state.projects[`proj-${basename(projectRoot)}`].startedAt = STALE_SERVICE_TIMESTAMP;
    mkdirSync(join(tmpRoot, ".aimux", "projects", `proj-${basename(projectRoot)}`), { recursive: true });
    writeMetadataEndpointFor(first.pid + 1);

    const second = await (daemon as any).ensureProject(projectRoot);

    expect(second.pid).not.toBe(first.pid);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(vi.mocked(requestJson)).toHaveBeenCalledTimes(2);
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

    expect(second.pid).not.toBe(first.pid);
    expect(spawnMock).toHaveBeenCalledTimes(2);
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

  it("respawns a dead project service on the next ensure call", async () => {
    const { AimuxDaemon } = await import("./daemon.js");

    const daemon = new AimuxDaemon();
    const first = await (daemon as any).ensureProject(projectRoot);
    livePids.delete(first.pid);

    const second = await (daemon as any).ensureProject(projectRoot);

    expect(second.pid).not.toBe(first.pid);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("keeps a just-started live project service when its metadata endpoint is missing", async () => {
    const { AimuxDaemon } = await import("./daemon.js");

    const daemon = new AimuxDaemon();
    const first = await (daemon as any).ensureProject(projectRoot);

    const second = await (daemon as any).ensureProject(projectRoot);

    expect(second.pid).toBe(first.pid);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(livePids.has(first.pid)).toBe(true);
  });

  it("waits for a just-started project service to publish its metadata endpoint", async () => {
    const { AimuxDaemon } = await import("./daemon.js");

    const daemon = new AimuxDaemon();
    const first = await (daemon as any).ensureProject(projectRoot);
    rmSync(join(tmpRoot, ".aimux", "projects", `proj-${basename(projectRoot)}`, "metadata-api.json"), {
      force: true,
    });

    setTimeout(() => writeMetadataEndpointFor(first.pid), 25);
    const second = await (daemon as any).ensureProject(projectRoot);

    expect(second.pid).toBe(first.pid);
    expect(spawnMock).toHaveBeenCalledTimes(1);
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
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // The threshold-crossing third failure replaces it, waiting for the old exit.
    const replacementPromise = (daemon as any).ensureProject(projectRoot);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const replacement = await replacementPromise;
    expect(replacement.pid).not.toBe(first.pid);
    expect(spawnMock).toHaveBeenCalledTimes(2);
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
    expect(second.pid).not.toBe(first.pid);
    expect(spawnMock).toHaveBeenCalledTimes(2);
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

    const { loadDaemonState } = await import("./daemon.js");
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

  it("inherits logging env and captures project service stdio when logging is enabled", async () => {
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
    const args = spawnMock.mock.calls[0]?.[1] as string[];
    const options = spawnMock.mock.calls[0]?.[2] as {
      env?: Record<string, string | undefined>;
      stdio?: unknown;
    };

    expect(project.pid).toBe(20_000);
    expect(args).toEqual([
      expect.any(String),
      "__project-service-internal",
      "--project-id",
      `proj-${basename(projectRoot)}`,
      "--project-root",
      projectRoot,
    ]);
    expect(options.env).toMatchObject({
      AIMUX_LOG: "1",
      AIMUX_LOG_LEVEL: "debug",
      AIMUX_LOG_CATEGORIES: "daemon,session",
    });
    expect(Array.isArray(options.stdio)).toBe(true);
    childrenByPid.get(project.pid)?.emit("exit", 0, null);
  });

  it("reads daemon host and port from environment overrides", async () => {
    const previousHost = process.env.AIMUX_DAEMON_HOST;
    const previousPort = process.env.AIMUX_DAEMON_PORT;
    try {
      process.env.AIMUX_DAEMON_HOST = "localhost";
      process.env.AIMUX_DAEMON_PORT = "44191";
      const { getDaemonHost, getDaemonPort } = await import("./daemon.js");

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
      const { getDaemonHost } = await import("./daemon.js");

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
      const { ensureDaemonRunning } = await import("./daemon.js");

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
      const { ensureDaemonRunning } = await import("./daemon.js");

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
      const { ensureDaemonRunning } = await import("./daemon.js");

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
      const { ensureDaemonRunning } = await import("./daemon.js");

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
      const { ensureDaemonRunning } = await import("./daemon.js");

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
      const { ensureDaemonRunning } = await import("./daemon.js");

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
    const { stopDaemon } = await import("./daemon.js");
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
    const { stopDaemon } = await import("./daemon.js");
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
    const { stopDaemon } = await import("./daemon.js");
    mkdirSync(join(tmpRoot, ".aimux", "daemon"), { recursive: true });
    livePids.add(50_001);
    livePids.add(50_002);
    execFileSyncMock.mockReturnValue(
      `node /opt/aimux/dist/main.js __project-service-internal --project-id proj-${basename(
        projectRoot,
      )} --project-root ${projectRoot}-old`,
    );
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

  it("reports verified retained project records as live services", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    const retainedPid = 43_102;
    livePids.add(retainedPid);
    mkdirSync(join(tmpRoot, ".aimux", "projects", `proj-${basename(projectRoot)}`), { recursive: true });
    writeMetadataEndpointFor(retainedPid);
    execFileSyncMock.mockReturnValue(
      `node /opt/aimux/dist/main.js __project-service-internal --project-id proj-${basename(
        projectRoot,
      )} --project-root ${projectRoot}`,
    );
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
    expect(project.serviceAlive).toBe(true);
    expect(project.service).toMatchObject({ pid: retainedPid });
  });

  it("caches retained project service verification for project list polling", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    const retainedPid = 43_103;
    livePids.add(retainedPid);
    mkdirSync(join(tmpRoot, ".aimux", "projects", `proj-${basename(projectRoot)}`), { recursive: true });
    writeMetadataEndpointFor(retainedPid);
    execFileSyncMock.mockReturnValue(
      `node /opt/aimux/dist/main.js __project-service-internal --project-id proj-${basename(
        projectRoot,
      )} --project-root ${projectRoot}`,
    );
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
    expect(psCalls).toHaveLength(1);
  });

  it("drops cached retained project service liveness when the pid exits", async () => {
    const { AimuxDaemon } = await import("./daemon.js");
    const daemon = new AimuxDaemon();
    const retainedPid = 43_104;
    livePids.add(retainedPid);
    mkdirSync(join(tmpRoot, ".aimux", "projects", `proj-${basename(projectRoot)}`), { recursive: true });
    writeMetadataEndpointFor(retainedPid);
    execFileSyncMock.mockReturnValue(
      `node /opt/aimux/dist/main.js __project-service-internal --project-id proj-${basename(
        projectRoot,
      )} --project-root ${projectRoot}`,
    );
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

    expect((first.body as any).projects[0].serviceAlive).toBe(true);
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
    expect((after.body as any).projects[0].service).toMatchObject({ pid: 30_000 });
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
