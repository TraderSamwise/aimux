import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestJson } from "./http-client.js";

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
  getProjectStateDir: () => join(tmpRoot, ".aimux", "projects", "global"),
  getProjectStateDirFor: (cwd: string) => join(tmpRoot, ".aimux", "projects", `proj-${basename(cwd)}`),
  getProjectIdFor: (cwd: string) => `proj-${basename(cwd)}`,
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
      port: 43191,
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

  it("waits for an unhealthy project service to exit before spawning a replacement", async () => {
    vi.mocked(requestJson).mockRejectedValueOnce(new Error("health failed"));
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

    const replacementPromise = (daemon as any).ensureProject(projectRoot);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const replacement = await replacementPromise;
    expect(replacement.pid).not.toBe(first.pid);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("serializes concurrent unhealthy project ensures into one replacement spawn", async () => {
    vi.mocked(requestJson)
      .mockRejectedValueOnce(new Error("health failed"))
      .mockRejectedValueOnce(new Error("health failed"));
    const { AimuxDaemon } = await import("./daemon.js");

    const daemon = new AimuxDaemon();
    const first = await (daemon as any).ensureProject(projectRoot);
    mkdirSync(join(tmpRoot, ".aimux", "projects", `proj-${basename(projectRoot)}`), { recursive: true });
    writeMetadataEndpointFor(first.pid);
    (daemon as any).state.projects[first.projectId].startedAt = new Date(Date.now() - 60_000).toISOString();

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
});
