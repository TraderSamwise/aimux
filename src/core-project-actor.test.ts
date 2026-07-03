import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actorMocks = vi.hoisted(() => ({
  cleanups: vi.fn(),
  cleanupPromise: null as Promise<void> | null,
  removeEndpoint: vi.fn(),
  startError: null as Error | null,
  starts: vi.fn(),
}));

vi.mock("./config.js", () => ({
  initProject: vi.fn(),
}));

vi.mock("./metadata-store.js", () => ({
  removeMetadataEndpoint: (...args: unknown[]) => actorMocks.removeEndpoint(...args),
}));

vi.mock("./multiplexer/index.js", () => ({
  Multiplexer: class {
    async startProjectServiceHost() {
      actorMocks.starts();
      if (actorMocks.startError) throw actorMocks.startError;
    }

    async cleanup() {
      actorMocks.cleanups();
      if (actorMocks.cleanupPromise) await actorMocks.cleanupPromise;
    }
  },
}));

vi.mock("./paths.js", () => ({
  ensureProjectPaths: vi.fn(),
  getProjectIdFor: (projectRoot: string) => `project-${projectRoot}`,
  withProjectPaths: async <T>(_projectRoot: string, fn: () => T | Promise<T>): Promise<T> => fn(),
}));

describe("CoreProjectActor", () => {
  beforeEach(() => {
    actorMocks.cleanups.mockReset();
    actorMocks.cleanupPromise = null;
    actorMocks.removeEndpoint.mockReset();
    actorMocks.startError = null;
    actorMocks.starts.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("cleans up a multiplexer when startup fails after creation", async () => {
    const { CoreProjectActor } = await import("./core-project-actor.js");
    const actor = new CoreProjectActor("/repo/alpha");
    actorMocks.startError = new Error("start failed");

    await expect(actor.start()).rejects.toThrow("start failed");

    expect(actor.isRunning()).toBe(false);
    expect(actorMocks.cleanups).toHaveBeenCalledTimes(1);
    expect(actorMocks.removeEndpoint).toHaveBeenCalledWith("/repo/alpha");

    actorMocks.startError = null;
    await expect(actor.start()).resolves.toMatchObject({
      projectRoot: "/repo/alpha",
      pid: process.pid,
    });
    expect(actorMocks.starts).toHaveBeenCalledTimes(2);
  });

  it("force-stops a running actor without waiting forever for cleanup", async () => {
    vi.useFakeTimers();
    const { CoreProjectActor } = await import("./core-project-actor.js");
    const actor = new CoreProjectActor("/repo/alpha");
    await actor.start();
    actorMocks.cleanupPromise = new Promise(() => {});

    const killed = actor.kill();
    await vi.advanceTimersByTimeAsync(1500);

    await expect(killed).resolves.toBeUndefined();
    expect(actor.isRunning()).toBe(false);
    expect(actorMocks.cleanups).toHaveBeenCalledTimes(1);
    expect(actorMocks.removeEndpoint).toHaveBeenCalledWith("/repo/alpha");
  });
});
