import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureLogging, resetLoggingForTests } from "./debug.js";

const actorMocks = vi.hoisted(() => ({
  ensureProjectPaths: vi.fn(),
  initProject: vi.fn(),
  launch: vi.fn(),
  removeEndpoint: vi.fn(),
  spawn: vi.fn(),
  isPidAlive: vi.fn(),
}));

interface MockChild extends EventEmitter {
  pid: number;
  unref: () => void;
}

let nextPid = 50_000;
let livePids: Set<number>;
let children: Map<number, MockChild>;
let projectRoot: string;

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => actorMocks.spawn(...args),
}));

vi.mock("./cli-launcher.js", () => ({
  getAimuxProjectServiceLaunchCommand: (...args: unknown[]) => actorMocks.launch(...args),
}));

vi.mock("./config.js", () => ({
  initProject: () => actorMocks.initProject(),
}));

vi.mock("./metadata-store.js", () => ({
  removeMetadataEndpoint: (...args: unknown[]) => actorMocks.removeEndpoint(...args),
}));

vi.mock("./paths.js", () => ({
  ensureProjectPaths: () => actorMocks.ensureProjectPaths(),
  getProjectIdFor: (root: string) => `project-${root.split("/").at(-1)}`,
  getProjectLogPathFor: (root: string) => join(root, ".aimux", "logs", "aimux.jsonl"),
  withProjectPaths: async <T>(_projectRoot: string, fn: () => T | Promise<T>): Promise<T> => fn(),
}));

vi.mock("./process-inspector.js", () => ({
  isPidAlive: (...args: unknown[]) => actorMocks.isPidAlive(...args),
}));

function createChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  child.pid = nextPid++;
  child.unref = vi.fn();
  livePids.add(child.pid);
  children.set(child.pid, child);
  return child;
}

describe("CoreProjectActor", () => {
  beforeEach(() => {
    vi.useRealTimers();
    nextPid = 50_000;
    livePids = new Set<number>();
    children = new Map<number, MockChild>();
    projectRoot = join(tmpdir(), `aimux-actor-${Date.now()}`);
    actorMocks.ensureProjectPaths.mockReset();
    actorMocks.initProject.mockReset();
    actorMocks.launch.mockReset();
    actorMocks.launch.mockReturnValue({
      command: "/usr/local/bin/aimux",
      args: ["__project-service-internal", "--project-id", "project-alpha", "--project-root", projectRoot],
      source: "stable-shim",
      currentEntryPath: "/opt/aimux/dist/launcher-bin.js",
      stableShimPath: "/usr/local/bin/aimux",
    });
    actorMocks.removeEndpoint.mockReset();
    actorMocks.spawn.mockReset();
    actorMocks.spawn.mockImplementation(() => createChild());
    actorMocks.isPidAlive.mockReset();
    actorMocks.isPidAlive.mockImplementation((pid: number) => livePids.has(pid));
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
      const numericPid = Number(pid);
      if (!livePids.has(numericPid)) throw new Error(`pid ${numericPid} is not alive`);
      if (signal && signal !== 0) {
        livePids.delete(numericPid);
        children.get(numericPid)?.emit("exit", 0, signal);
      }
      return true;
    }) as typeof process.kill);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetLoggingForTests();
  });

  it("spawns a standalone project service with child pid identity", async () => {
    const { CoreProjectActor } = await import("./core-project-actor.js");
    const actor = new CoreProjectActor(projectRoot);

    const state = await actor.start();

    expect(state).toMatchObject({
      projectId: expect.stringContaining("project-"),
      projectRoot,
      pid: 50_000,
      status: "running",
      restartCount: 0,
    });
    expect(state.pid).not.toBe(process.pid);
    expect(actorMocks.launch).toHaveBeenCalledWith(state.projectId, projectRoot);
    expect(actorMocks.spawn).toHaveBeenCalledWith(
      "/usr/local/bin/aimux",
      ["__project-service-internal", "--project-id", "project-alpha", "--project-root", projectRoot],
      expect.objectContaining({
        cwd: projectRoot,
        stdio: "ignore",
      }),
    );
    expect(actorMocks.ensureProjectPaths).toHaveBeenCalledTimes(1);
    expect(actorMocks.initProject).toHaveBeenCalledTimes(1);
  });

  it("passes logging configuration into the child process environment and stdio", async () => {
    configureLogging({
      enabled: true,
      level: "debug",
      categories: ["daemon", "runtime"],
      path: join(projectRoot, "daemon.jsonl"),
      processKind: "daemon",
    });
    const { CoreProjectActor } = await import("./core-project-actor.js");
    const actor = new CoreProjectActor(projectRoot);

    await actor.start();

    expect(actorMocks.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          AIMUX_LOG: "1",
          AIMUX_LOG_LEVEL: "debug",
          AIMUX_LOG_CATEGORIES: "daemon,runtime",
          AIMUX_PROJECT_ROOT: projectRoot,
        }),
        stdio: expect.any(Array),
      }),
    );
  });

  it("stops a running child with SIGTERM and removes its endpoint", async () => {
    const { CoreProjectActor } = await import("./core-project-actor.js");
    const actor = new CoreProjectActor(projectRoot);
    const state = await actor.start();

    await actor.stop();

    expect(process.kill).toHaveBeenCalledWith(state.pid, "SIGTERM");
    expect(actor.isRunning()).toBe(false);
    expect(actor.getState()).toMatchObject({ pid: 0, status: "stopped" });
    expect(actorMocks.removeEndpoint).toHaveBeenCalledWith(projectRoot);
  });

  it("force kills a running child", async () => {
    const { CoreProjectActor } = await import("./core-project-actor.js");
    const actor = new CoreProjectActor(projectRoot);
    const state = await actor.start();

    await actor.kill();

    expect(process.kill).toHaveBeenCalledWith(state.pid, "SIGKILL");
    expect(actor.getState()).toMatchObject({ pid: 0, status: "stopped" });
    expect(actorMocks.removeEndpoint).toHaveBeenCalledWith(projectRoot);
  });

  it("restarts after an unexpected child exit", async () => {
    vi.useFakeTimers();
    const changes: unknown[] = [];
    const { CoreProjectActor } = await import("./core-project-actor.js");
    const actor = new CoreProjectActor(projectRoot, {
      onStateChange: (state) => changes.push(state),
    });
    const first = await actor.start();

    livePids.delete(first.pid);
    children.get(first.pid)?.emit("exit", 1, null);

    expect(actor.getState()).toMatchObject({
      pid: first.pid,
      status: "restarting",
      restartCount: 1,
      lastExit: expect.objectContaining({ code: 1, signal: null, expected: false }),
    });
    expect(actorMocks.removeEndpoint).toHaveBeenCalledWith(projectRoot);

    await vi.advanceTimersByTimeAsync(250);

    const second = actor.getState();
    expect(second.pid).toBe(50_001);
    expect(second.status).toBe("running");
    expect(second.lastRestartAt).toBeDefined();
    expect(actorMocks.spawn).toHaveBeenCalledTimes(2);
    expect(changes.length).toBeGreaterThan(2);
  });

  it("does not restart after an intentional stop", async () => {
    vi.useFakeTimers();
    const { CoreProjectActor } = await import("./core-project-actor.js");
    const actor = new CoreProjectActor(projectRoot);
    await actor.start();

    await actor.stop();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(actorMocks.spawn).toHaveBeenCalledTimes(1);
    expect(actor.getState()).toMatchObject({ pid: 0, status: "stopped" });
  });

  it("removes stale endpoint metadata when spawn throws", async () => {
    actorMocks.spawn.mockImplementationOnce(() => {
      throw new Error("spawn failed");
    });
    const { CoreProjectActor } = await import("./core-project-actor.js");
    const actor = new CoreProjectActor(projectRoot);

    await expect(actor.start()).rejects.toThrow("spawn failed");

    expect(actor.isRunning()).toBe(false);
    expect(actor.getState()).toMatchObject({ pid: 0, status: "stopped" });
    expect(actorMocks.removeEndpoint).toHaveBeenCalledWith(projectRoot);
  });
});
