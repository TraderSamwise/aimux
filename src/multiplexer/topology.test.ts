import { describe, expect, it, vi } from "vitest";

const renderTopologyScreen = vi.hoisted(() => vi.fn());

vi.mock("../tui/screens/subscreen-renderers.js", () => ({
  renderTopologyScreen,
}));

import { handleTopologyKey, refreshTopology } from "./topology.js";

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

  it("does not redraw topology after manual refresh when the user has navigated away", async () => {
    let resolveRefresh!: (value: unknown) => void;
    const host: any = {
      topology: { rows: [] },
      getFromProjectService: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      ),
      isDashboardScreen: vi.fn(() => false),
      handleDashboardSubscreenNavigationKey: vi.fn(() => false),
    };

    handleTopologyKey(host, Buffer.from("r"));
    resolveRefresh({
      ok: true,
      topology: { projectName: "aimux", counts: {}, worktrees: [], rows: [] },
    });
    await vi.waitFor(() => expect(host.getFromProjectService).toHaveBeenCalledWith("/topology"));
    await Promise.resolve();

    expect(renderTopologyScreen).not.toHaveBeenCalled();
  });
});
