import { describe, expect, it, vi } from "vitest";
import { InstanceDirectory } from "./instance-directory.js";
import type { InstanceInfo, InstanceSessionRef } from "./instance-registry.js";

describe("InstanceDirectory", () => {
  it("returns remote instances safely and derives owned keys", () => {
    const instances: InstanceInfo[] = [
      {
        instanceId: "other-1",
        pid: 123,
        startedAt: "2026-03-30T00:00:00.000Z",
        heartbeat: "2026-03-30T00:00:00.000Z",
        cwd: "/tmp",
        sessions: [
          { id: "remote-1", tool: "codex", backendSessionId: "backend-1" },
          { id: "remote-2", tool: "claude" },
        ],
      },
    ];

    const directory = new InstanceDirectory({
      getRemoteInstances: () => instances,
    });

    expect(directory.getRemoteInstancesSafe("self", "/tmp")).toEqual(instances);
    expect(directory.getRemoteOwnedSessionKeys("self", "/tmp")).toEqual(new Set(["remote-1", "backend-1", "remote-2"]));
  });

  it("handles remote instance lookup failures", () => {
    const directory = new InstanceDirectory({
      getRemoteInstances: () => {
        throw new Error("boom");
      },
    });

    expect(directory.getRemoteInstancesSafe("self", "/tmp")).toEqual([]);
    expect(directory.getRemoteOwnedSessionKeys("self", "/tmp")).toEqual(new Set());
  });

  it("proxies heartbeat and claim calls", async () => {
    const registerInstanceMock = vi.fn<() => Promise<InstanceInfo[]>>().mockResolvedValue([]);
    const unregisterInstanceMock = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const updateHeartbeatMock = vi.fn<() => Promise<string[]>>().mockResolvedValue(["s1"]);
    const claimSessionMock = vi
      .fn<() => Promise<InstanceSessionRef | undefined>>()
      .mockResolvedValue({ id: "s1", tool: "codex", backendSessionId: "backend-1" });

    const directory = new InstanceDirectory({
      registerInstance: registerInstanceMock as any,
      unregisterInstance: unregisterInstanceMock as any,
      updateHeartbeat: updateHeartbeatMock as any,
      claimSession: claimSessionMock as any,
    });

    expect(await directory.registerInstance("self", "/tmp")).toEqual([]);
    await directory.unregisterInstance("self", "/tmp");
    expect(await directory.updateHeartbeat("self", [], "/tmp")).toEqual(["s1"]);
    expect(await directory.claimSession("s1", "other-1", "/tmp")).toEqual({
      id: "s1",
      tool: "codex",
      backendSessionId: "backend-1",
    });
  });

  it("builds sessions file entries with remote dedupe", () => {
    const directory = new InstanceDirectory();
    const localSessions: InstanceSessionRef[] = [
      { id: "local-1", tool: "codex", backendSessionId: "backend-local", worktreePath: "/repo" },
    ];
    const remoteInstances: InstanceInfo[] = [
      {
        instanceId: "other-1",
        pid: 321,
        startedAt: "2026-03-30T00:00:00.000Z",
        heartbeat: "2026-03-30T00:00:00.000Z",
        cwd: "/tmp",
        sessions: [
          { id: "local-1", tool: "codex" },
          { id: "remote-1", tool: "claude", backendSessionId: "backend-remote", worktreePath: "/repo/w1" },
        ],
      },
    ];

    expect(directory.buildSessionsFileEntries(localSessions, remoteInstances)).toEqual([
      {
        id: "local-1",
        tool: "codex",
        status: "running",
        backendSessionId: "backend-local",
        worktreePath: "/repo",
      },
      {
        id: "remote-1",
        tool: "claude",
        status: "running",
        backendSessionId: "backend-remote",
        worktreePath: "/repo/w1",
        instance: "PID 321",
      },
    ]);
  });
});
