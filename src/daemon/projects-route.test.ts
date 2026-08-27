import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestJson: vi.fn(),
}));

vi.mock("../http-client.js", () => ({
  requestJson: mocks.requestJson,
}));

import { countOnlineDesktopAgents, ProjectOnlineAgentCountReader } from "./projects-route.js";

describe("countOnlineDesktopAgents", () => {
  it("counts online sessions from worktree groups and hides overseers", () => {
    expect(
      countOnlineDesktopAgents({
        worktreeGroups: [
          {
            sessions: [
              { status: "running" },
              { status: "offline" },
              { status: "exited" },
              { status: "idle", overseer: true },
              { status: "idle", team: { role: "overseer" } },
              { status: "offline", pendingAction: { kind: "spawn" } },
            ],
          },
          { sessions: [{ status: "waiting" }] },
        ],
      }),
    ).toBe(3);
  });

  it("falls back to top-level sessions and teammates", () => {
    expect(
      countOnlineDesktopAgents({
        sessions: [{ status: "running" }, { status: "offline" }],
        teammates: [{ status: "idle" }, { status: "exited" }],
      }),
    ).toBe(2);
  });

  it("returns undefined when no known session collections are present", () => {
    expect(countOnlineDesktopAgents({})).toBeUndefined();
  });
});

describe("ProjectOnlineAgentCountReader", () => {
  it("returns zero and skips network reads for offline services", async () => {
    const reader = new ProjectOnlineAgentCountReader();

    await expect(reader.read("project-one", false, { host: "127.0.0.1", port: 1234, pid: 99 })).resolves.toBe(0);
    expect(mocks.requestJson).not.toHaveBeenCalled();
  });

  it("caches successful project desktop-state counts", async () => {
    mocks.requestJson.mockResolvedValue({
      status: 200,
      json: { sessions: [{ status: "running" }, { status: "offline" }] },
    });
    const reader = new ProjectOnlineAgentCountReader();

    await expect(reader.read("project-two", true, { host: "127.0.0.1", port: 1234, pid: 99 })).resolves.toBe(1);
    await expect(reader.read("project-two", true, { host: "127.0.0.1", port: 1234, pid: 99 })).resolves.toBe(1);

    expect(mocks.requestJson).toHaveBeenCalledTimes(1);
  });
});
