import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestJson } from "./http-client.js";
import { configureLogging, resetLoggingForTests } from "./debug.js";

let tmpRoot = "";
let projectRoot = "";
let nextPid = 20_000;
let livePids = new Set<number>();
let childrenByPid = new Map<number, EventEmitter>();
const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

vi.mock("./paths.js", () => ({
  getDaemonInfoPath: () => join(tmpRoot, ".aimux", "daemon", "daemon.json"),
  getDaemonStatePath: () => join(tmpRoot, ".aimux", "daemon", "state.json"),
  getDaemonStdioLogPath: () => join(tmpRoot, ".aimux", "daemon", "logs", "daemon-stdio.log"),
  getAuthPath: () => join(tmpRoot, ".aimux", "auth.json"),
  getProjectStateDir: () => join(tmpRoot, ".aimux", "projects", "global"),
  getProjectStateDirFor: (cwd: string) => join(tmpRoot, ".aimux", "projects", `proj-${basename(cwd)}`),
  getProjectIdFor: (cwd: string) => `proj-${basename(cwd)}`,
  getProjectServiceStdioLogPathFor: (cwd: string) =>
    join(tmpRoot, ".aimux", "projects", `proj-${basename(cwd)}`, "logs", "project-service-stdio.log"),
}));

vi.mock("./project-scanner.js", () => ({
  listDesktopProjects: () => [
    {
      id: `proj-${basename(projectRoot)}`,
      name: basename(projectRoot),
      path: projectRoot,
      dashboardSessionName: "aimux-test",
      sessions: [],
    },
  ],
}));

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
    vi.mocked(requestJson).mockReset();
    vi.mocked(requestJson).mockResolvedValue({
      status: 200,
      json: { ok: true },
    });
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
      child.pid = nextPid++;
      child.unref = () => {};
      livePids.add(child.pid);
      childrenByPid.set(child.pid, child);
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
    vi.mocked(requestJson).mockResolvedValue({
      status: 200,
      json: {
        ok: true,
        serviceInfo: { apiVersion: 4, capabilities: {}, buildStamp: "old-build" },
      },
    });
    const { AimuxDaemon } = await import("./daemon.js");

    const daemon = new AimuxDaemon();
    const first = await (daemon as any).ensureProject(projectRoot);
    mkdirSync(join(tmpRoot, ".aimux", "projects", `proj-${basename(projectRoot)}`), { recursive: true });
    writeMetadataEndpointFor(first.pid);

    const second = await (daemon as any).ensureProject(projectRoot);

    expect(second.pid).not.toBe(first.pid);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(livePids.has(first.pid)).toBe(false);
    expect(livePids.has(second.pid)).toBe(true);
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

  it("waits for a repeatedly-unhealthy project service to exit before spawning a replacement", async () => {
    vi.mocked(requestJson).mockRejectedValue(new Error("health failed"));
    const { AimuxDaemon } = await import("./daemon.js");

    const daemon = new AimuxDaemon();
    const first = await (daemon as any).ensureProject(projectRoot);
    mkdirSync(join(tmpRoot, ".aimux", "projects", `proj-${basename(projectRoot)}`), { recursive: true });
    writeMetadataEndpointFor(first.pid);
    (daemon as any).state.projects[first.projectId].startedAt = new Date(Date.now() - 60_000).toISOString();

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
    vi.mocked(requestJson).mockRejectedValue(new Error("health failed"));
    const { AimuxDaemon } = await import("./daemon.js");

    const daemon = new AimuxDaemon();
    const first = await (daemon as any).ensureProject(projectRoot);
    mkdirSync(join(tmpRoot, ".aimux", "projects", `proj-${basename(projectRoot)}`), { recursive: true });
    writeMetadataEndpointFor(first.pid);
    (daemon as any).state.projects[first.projectId].startedAt = new Date(Date.now() - 60_000).toISOString();

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

  it("prunes dead services from persisted daemon state", async () => {
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

    expect(Object.keys(state.projects)).toEqual(["proj-live"]);
    const persisted = JSON.parse(readFileSync(daemonStatePath, "utf-8")) as { projects: Record<string, unknown> };
    expect(Object.keys(persisted.projects)).toEqual(["proj-live"]);
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
    const options = spawnMock.mock.calls[0]?.[2] as {
      env?: Record<string, string | undefined>;
      stdio?: unknown;
    };

    expect(project.pid).toBe(20_000);
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
        json: { ok: true, pid: 50_001, port: 44191 },
      });
      const { ensureDaemonRunning } = await import("./daemon.js");

      const info = await ensureDaemonRunning();

      expect(info.port).toBe(44191);
      expect(vi.mocked(requestJson)).toHaveBeenCalledWith("http://127.0.0.1:44191/health");
    } finally {
      if (previousPort === undefined) {
        delete process.env.AIMUX_DAEMON_PORT;
      } else {
        process.env.AIMUX_DAEMON_PORT = previousPort;
      }
    }
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
      return child;
    });
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
