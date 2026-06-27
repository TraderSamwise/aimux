import { describe, expect, it, vi } from "vitest";
import { buildProjectTopology, type ProjectTopology } from "../project-topology.js";

const renderTopologyScreen = vi.hoisted(() => vi.fn());

vi.mock("../tui/screens/subscreen-renderers.js", () => ({
  renderTopologyScreen,
}));

import { handleTopologyKey, refreshTopology } from "./topology.js";

describe("refreshTopology", () => {
  function topologyModel(rows: ProjectTopology["rows"] = []) {
    return {
      projectName: "aimux",
      health: "active",
      counts: { worktrees: 1, agents: rows.length, services: 0 },
      worktrees: [{ name: "main", branch: "main", health: "active", agents: rows.length, services: 0 }],
      rows,
    };
  }

  it("loads the topology model from the project service", async () => {
    const topology = topologyModel([
      { kind: "agent", depth: 1, label: "claude", health: "active", sessionId: "live-1" },
    ]);
    const host: any = {
      topologyIndex: -1,
      getFromProjectService: vi.fn(async () => ({ ok: true, topology })),
    };

    await expect(refreshTopology(host)).resolves.toBe(true);

    expect(host.getFromProjectService).toHaveBeenCalledWith("/topology");
    expect(host.topology).toBe(topology);
    expect(host.topologyLoaded).toBe(true);
    expect(host.topologyIndex).toBe(0);
  });

  it("coalesces concurrent topology refreshes through the TUI API runtime", async () => {
    const topology = topologyModel([
      { kind: "agent", depth: 1, label: "claude", health: "active", sessionId: "live-1" },
    ]);
    let resolveRefresh!: (value: unknown) => void;
    const host: any = {
      topologyIndex: -1,
      getFromProjectService: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      ),
    };

    const first = refreshTopology(host);
    const second = refreshTopology(host);
    resolveRefresh({ ok: true, topology });

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);

    expect(host.getFromProjectService).toHaveBeenCalledTimes(1);
    expect(host.topology).toBe(topology);
  });

  it("initializes an empty topology instead of building from local dashboard groups on failure", async () => {
    const host: any = {
      dashboardWorktreeGroupsCache: [{ name: "main", branch: "main", sessions: [{ id: "local" }], services: [] }],
      getFromProjectService: vi.fn(async () => ({
        ok: true,
        topology: { projectName: "aimux", health: "active", counts: {}, worktrees: [], rows: [] },
      })),
    };

    await expect(refreshTopology(host)).resolves.toBe(false);

    expect(host.topology.rows).toEqual([]);
    expect(host.topologyLoaded).toBe(true);
    expect(host.topology.counts).toEqual({ worktrees: 0, agents: 0, services: 0 });
  });

  it("preserves the loaded topology when a refresh payload is invalid", async () => {
    const topology = topologyModel([
      { kind: "agent", depth: 1, label: "codex", health: "active", sessionId: "codex-1" },
    ]);
    const invalidTopology = topologyModel([{ kind: "agent", depth: 1, label: "bad", health: "unknown" } as any]);
    const host: any = {
      topology,
      topologyLoaded: true,
      topologyIndex: 0,
      getFromProjectService: vi.fn(async () => ({ ok: true, topology: invalidTopology })),
    };

    await expect(refreshTopology(host)).resolves.toBe(false);

    expect(host.topology).toBe(topology);
    expect(host.topology.rows[0].label).toBe("codex");
  });

  it("preserves the loaded topology when the service request rejects", async () => {
    const topology = topologyModel([
      { kind: "service", depth: 1, label: "web", health: "active", serviceId: "service-1" },
    ]);
    const host: any = {
      topology,
      topologyLoaded: true,
      getFromProjectService: vi.fn(async () => {
        throw new Error("offline");
      }),
    };

    await expect(refreshTopology(host)).resolves.toBe(false);

    expect(host.topology).toBe(topology);
  });

  it("applies a valid empty topology over previously loaded state", async () => {
    const topology = topologyModel([{ kind: "agent", depth: 1, label: "old", health: "active", sessionId: "old-1" }]);
    const emptyTopology = buildProjectTopology({ projectName: "aimux", worktrees: [] });
    const host: any = {
      topology,
      topologyLoaded: true,
      getFromProjectService: vi.fn(async () => ({ ok: true, topology: emptyTopology })),
    };

    await expect(refreshTopology(host)).resolves.toBe(true);

    expect(host.topology).toBe(emptyTopology);
    expect(host.topology.rows).toEqual([]);
  });

  it("does not redraw topology after manual refresh when the user has navigated away", async () => {
    const host: any = {
      topology: { rows: [] },
      getFromProjectService: vi.fn(async () => ({ ok: true, topology: topologyModel([]) })),
      isDashboardScreen: vi.fn(() => false),
      handleDashboardSubscreenNavigationKey: vi.fn(() => false),
    };

    handleTopologyKey(host, Buffer.from("r"));
    await Promise.resolve();

    expect(host.getFromProjectService).not.toHaveBeenCalled();
    expect(renderTopologyScreen).not.toHaveBeenCalled();
  });

  it("keeps the old topology when a pending lifecycle refresh completes after navigation", async () => {
    let resolveRefresh!: (value: unknown) => void;
    const previous = topologyModel([{ kind: "agent", depth: 1, label: "old", health: "active", sessionId: "old-1" }]);
    const next = topologyModel([{ kind: "agent", depth: 1, label: "new", health: "active", sessionId: "new-1" }]);
    const host: any = {
      dashboardInputEpoch: 1,
      topology: previous,
      topologyLoaded: true,
      getFromProjectService: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      ),
    };

    const refresh = refreshTopology(host, {
      lifecycle: { mode: "dashboard", inputEpoch: 1, requiresInputEpoch: true },
    });
    host.dashboardInputEpoch = 2;
    resolveRefresh({ ok: true, topology: next });

    await expect(refresh).resolves.toBe(false);
    expect(host.topology).toBe(previous);
  });

  it("redraws topology after manual refresh when input changes but the screen stays active", async () => {
    vi.clearAllMocks();
    let resolveRefresh!: (value: unknown) => void;
    const topology = topologyModel([]);
    const host: any = {
      dashboardInputEpoch: 1,
      topology: { rows: [] },
      getFromProjectService: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      ),
      isDashboardScreen: vi.fn((screen: string) => screen === "topology"),
      handleDashboardSubscreenNavigationKey: vi.fn(() => false),
    };

    handleTopologyKey(host, Buffer.from("r"));
    host.dashboardInputEpoch = 2;
    resolveRefresh({ ok: true, topology });

    await vi.waitFor(() => expect(renderTopologyScreen).toHaveBeenCalled());
  });
});
