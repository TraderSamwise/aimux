import { describe, expect, it, vi } from "vitest";

import { refreshTopology } from "./topology.js";

describe("refreshTopology", () => {
  it("loads the topology model from the project service", async () => {
    const topology = {
      projectName: "aimux",
      health: "active",
      counts: { worktrees: 1, agents: 1, services: 0 },
      worktrees: [{ name: "main", branch: "main", health: "active", agents: 1, services: 0 }],
      rows: [{ kind: "agent", depth: 1, label: "claude", health: "active", sessionId: "live-1" }],
    };
    const host: any = {
      topologyIndex: 4,
      getFromProjectService: vi.fn(async () => ({ ok: true, topology })),
    };

    await expect(refreshTopology(host)).resolves.toBe(true);

    expect(host.getFromProjectService).toHaveBeenCalledWith("/topology");
    expect(host.topology).toBe(topology);
    expect(host.topologyIndex).toBe(0);
  });

  it("initializes an empty topology instead of building from local dashboard groups on failure", async () => {
    const host: any = {
      dashboardWorktreeGroupsCache: [{ name: "main", branch: "main", sessions: [{ id: "local" }], services: [] }],
      getFromProjectService: vi.fn(async () => ({ ok: true, topology: { rows: [] } })),
    };

    await expect(refreshTopology(host)).resolves.toBe(false);

    expect(host.topology.rows).toEqual([]);
    expect(host.topology.counts).toEqual({ worktrees: 0, agents: 0, services: 0 });
  });
});
