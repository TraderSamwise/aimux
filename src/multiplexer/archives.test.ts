import { beforeEach, describe, expect, it, vi } from "vitest";

const renderGraveyardScreen = vi.hoisted(() => vi.fn());
const postToProjectService = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

vi.mock("../tui/screens/subscreen-renderers.js", () => ({
  renderGraveyardDetails: vi.fn(() => []),
  renderGraveyardScreen,
}));

vi.mock("./dashboard-control.js", () => ({
  postToProjectService,
}));

import { handleGraveyardKey, refreshGraveyardEntriesFromService, resurrectGraveyardEntry } from "./archives.js";

function graveyardPayload() {
  const entry = { id: "codex-old", tool: "codex", command: "codex", status: "graveyard" };
  const row = { kind: "orphan-agent", entry, actionIndex: 0, actionNumber: 1 };
  return {
    ok: true,
    entries: [entry],
    worktrees: [],
    viewModel: { rows: [{ kind: "section", label: "Orphaned Agents" }, row], selectableRows: [row] },
  };
}

describe("refreshGraveyardEntriesFromService", () => {
  beforeEach(() => {
    renderGraveyardScreen.mockClear();
    postToProjectService.mockReset();
    postToProjectService.mockResolvedValue({ ok: true });
  });

  it("loads entries and the view model from the project service", async () => {
    const payload = graveyardPayload();
    const host: any = {
      graveyardIndex: -1,
      getFromProjectService: vi.fn(async () => payload),
      isDashboardScreen: vi.fn(() => true),
    };

    await expect(refreshGraveyardEntriesFromService(host)).resolves.toBe(true);

    expect(host.getFromProjectService).toHaveBeenCalledWith("/graveyard", { timeoutMs: 3000 });
    expect(host.graveyardEntries).toBe(payload.entries);
    expect(host.worktreeGraveyardEntries).toBe(payload.worktrees);
    expect(host.graveyardViewModel).toBe(payload.viewModel);
    expect(host.graveyardIndex).toBe(0);
    expect(renderGraveyardScreen).toHaveBeenCalledWith(host);
  });

  it("coalesces concurrent graveyard refreshes through the TUI API runtime", async () => {
    const payload = graveyardPayload();
    let resolveRefresh!: (value: unknown) => void;
    const host: any = {
      graveyardIndex: -1,
      getFromProjectService: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      ),
      isDashboardScreen: vi.fn(() => false),
    };

    const first = refreshGraveyardEntriesFromService(host);
    const second = refreshGraveyardEntriesFromService(host);
    resolveRefresh(payload);

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);

    expect(host.getFromProjectService).toHaveBeenCalledTimes(1);
    expect(host.graveyardViewModel).toBe(payload.viewModel);
  });

  it("forces post-mutation refreshes past older pending graveyard reads", async () => {
    const stale = graveyardPayload();
    const fresh = { ok: true, entries: [], worktrees: [], viewModel: { rows: [], selectableRows: [] } };
    let resolveStale!: (value: unknown) => void;
    let resolveFresh!: (value: unknown) => void;
    const staleRequest = new Promise((resolve) => {
      resolveStale = resolve;
    });
    const freshRequest = new Promise((resolve) => {
      resolveFresh = resolve;
    });
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      isDashboardScreen: vi.fn((screen: string) => screen === "graveyard"),
      activeIndex: 0,
      graveyardIndex: 0,
      graveyardViewModel: stale.viewModel,
      getFromProjectService: vi.fn().mockReturnValueOnce(staleRequest).mockReturnValueOnce(freshRequest),
      refreshDashboardModelFromService: vi.fn(async () => true),
      setDashboardScreen: vi.fn(),
      renderDashboard: vi.fn(),
    };

    const passiveRefresh = refreshGraveyardEntriesFromService(host);
    resurrectGraveyardEntry(host, 0);
    await vi.waitFor(() => expect(host.getFromProjectService).toHaveBeenCalledTimes(2));

    resolveFresh(fresh);
    await vi.waitFor(() => expect(host.graveyardViewModel).toBe(fresh.viewModel));
    resolveStale(stale);
    await expect(passiveRefresh).resolves.toBe(false);

    expect(host.graveyardViewModel).toBe(fresh.viewModel);
    expect(host.setDashboardScreen).toHaveBeenCalledWith("dashboard");
  });

  it("initializes an empty model instead of rebuilding from local stores on invalid payloads", async () => {
    const host: any = {
      listGraveyardEntries: vi.fn(),
      listWorktreeGraveyardEntries: vi.fn(),
      getFromProjectService: vi.fn(async () => ({ ok: true, entries: [], worktrees: [] })),
    };

    await expect(refreshGraveyardEntriesFromService(host)).resolves.toBe(false);

    expect(host.listGraveyardEntries).not.toHaveBeenCalled();
    expect(host.listWorktreeGraveyardEntries).not.toHaveBeenCalled();
    expect(host.graveyardViewModel).toEqual({ rows: [], selectableRows: [] });
  });

  it("does not render a graveyard refresh after newer dashboard input", async () => {
    const payload = graveyardPayload();
    let resolveRefresh!: (value: unknown) => void;
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      graveyardIndex: -1,
      getFromProjectService: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      ),
      isDashboardScreen: vi.fn((screen: string) => screen === "graveyard"),
    };

    const lifecycle = { mode: "dashboard" as const, inputEpoch: 0, requiresInputEpoch: true, screen: "graveyard" };
    const refresh = refreshGraveyardEntriesFromService(host, { lifecycle });
    host.dashboardInputEpoch = 1;
    resolveRefresh(payload);

    await expect(refresh).resolves.toBe(true);

    expect(host.graveyardViewModel).toBe(payload.viewModel);
    expect(renderGraveyardScreen).not.toHaveBeenCalled();
  });

  it("does not wipe graveyard state from a stale invalid refresh", async () => {
    const payload = graveyardPayload();
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 1,
      graveyardEntries: payload.entries,
      worktreeGraveyardEntries: payload.worktrees,
      graveyardViewModel: payload.viewModel,
      getFromProjectService: vi.fn(async () => ({ ok: true, entries: [], worktrees: [] })),
      isDashboardScreen: vi.fn((screen: string) => screen === "graveyard"),
    };

    const lifecycle = { mode: "dashboard" as const, inputEpoch: 0, requiresInputEpoch: true, screen: "graveyard" };

    await expect(refreshGraveyardEntriesFromService(host, { lifecycle })).resolves.toBe(false);

    expect(host.graveyardViewModel).toBe(payload.viewModel);
    expect(renderGraveyardScreen).not.toHaveBeenCalled();
  });
});

describe("resurrectGraveyardEntry", () => {
  beforeEach(() => {
    renderGraveyardScreen.mockClear();
    postToProjectService.mockReset();
    postToProjectService.mockResolvedValue({ ok: true });
  });

  it("posts the mutation and refreshes graveyard state from the service", async () => {
    const initial = graveyardPayload();
    const refreshed = { ok: true, entries: [], worktrees: [], viewModel: { rows: [], selectableRows: [] } };
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      isDashboardScreen: vi.fn((screen: string) => screen === "graveyard"),
      activeIndex: 0,
      graveyardIndex: 0,
      graveyardViewModel: initial.viewModel,
      getFromProjectService: vi.fn(async () => refreshed),
      refreshDashboardModelFromService: vi.fn(async () => true),
      listGraveyardEntries: vi.fn(),
      listWorktreeGraveyardEntries: vi.fn(),
      setDashboardScreen: vi.fn(),
      renderDashboard: vi.fn(),
    };

    resurrectGraveyardEntry(host, 0);

    await vi.waitFor(() =>
      expect(postToProjectService).toHaveBeenCalledWith(
        host,
        "/graveyard/resurrect",
        { sessionId: "codex-old" },
        { timeoutMs: 10_000 },
      ),
    );
    await vi.waitFor(() => expect(host.getFromProjectService).toHaveBeenCalledWith("/graveyard", { timeoutMs: 3000 }));
    await vi.waitFor(() => expect(host.refreshDashboardModelFromService).toHaveBeenCalledWith(true));

    expect(host.listGraveyardEntries).not.toHaveBeenCalled();
    expect(host.listWorktreeGraveyardEntries).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(host.setDashboardScreen).toHaveBeenCalledWith("dashboard"));
    expect(host.renderDashboard).toHaveBeenCalled();
  });

  it("shows resurrection failures and refreshes service state", async () => {
    postToProjectService.mockRejectedValueOnce(new Error("late timeout"));
    const initial = graveyardPayload();
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      isDashboardScreen: vi.fn((screen: string) => screen === "graveyard"),
      graveyardIndex: 0,
      graveyardViewModel: initial.viewModel,
      getFromProjectService: vi.fn(async () => initial),
      refreshDashboardModelFromService: vi.fn(async () => true),
      showDashboardError: vi.fn(),
    };

    resurrectGraveyardEntry(host, 0);

    await vi.waitFor(() =>
      expect(host.showDashboardError).toHaveBeenCalledWith('Failed to resurrect "codex-old"', ["late timeout"]),
    );
    await vi.waitFor(() => expect(host.getFromProjectService).toHaveBeenCalledWith("/graveyard", { timeoutMs: 3000 }));
    expect(host.refreshDashboardModelFromService).toHaveBeenCalledWith(true);
  });

  it("does not suppress non-dashboard resurrection failures", async () => {
    const initial = graveyardPayload();
    const host: any = {
      mode: "session",
      graveyardIndex: 0,
      graveyardViewModel: initial.viewModel,
      resurrectGraveyardSession: vi.fn(async () => {
        throw new Error("local restore failed");
      }),
      showDashboardError: vi.fn(),
    };

    resurrectGraveyardEntry(host, 0);

    await vi.waitFor(() =>
      expect(host.showDashboardError).toHaveBeenCalledWith('Failed to resurrect "codex-old"', ["local restore failed"]),
    );
  });

  it("treats successful resurrection with failed authoritative refresh as stale", async () => {
    const initial = graveyardPayload();
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      isDashboardScreen: vi.fn((screen: string) => screen === "graveyard"),
      activeIndex: 0,
      graveyardIndex: 0,
      graveyardViewModel: initial.viewModel,
      getFromProjectService: vi.fn(async () => ({ ok: true, entries: [], worktrees: [] })),
      refreshDashboardModelFromService: vi.fn(async () => true),
      showDashboardError: vi.fn(),
      setDashboardScreen: vi.fn(),
      renderDashboard: vi.fn(),
    };

    resurrectGraveyardEntry(host, 0);

    await vi.waitFor(() =>
      expect(host.showDashboardError).toHaveBeenCalledWith('Failed to resurrect "codex-old"', [
        "graveyard snapshot unavailable after resurrection",
      ]),
    );
    expect(host.setDashboardScreen).not.toHaveBeenCalled();
    expect(host.renderDashboard).not.toHaveBeenCalled();
  });

  it("clears worktree delete confirmation after delete failures", async () => {
    postToProjectService.mockRejectedValueOnce(new Error("delete failed"));
    const entry = { name: "demo", path: "/repo/.aimux/worktrees/demo" };
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      graveyardWorktreeDeleteConfirm: entry,
      dashboardState: { toggleDetailsSidebar: vi.fn() },
      isDashboardScreen: vi.fn((screen: string) => screen === "graveyard"),
      handleDashboardSubscreenNavigationKey: vi.fn(() => false),
      exitDashboardClientOrProcess: vi.fn(),
      setDashboardScreen: vi.fn(),
      renderDashboard: vi.fn(),
      showHelp: vi.fn(),
      showDashboardError: vi.fn(),
    };

    handleGraveyardKey(host, Buffer.from("y"));

    await vi.waitFor(() =>
      expect(host.showDashboardError).toHaveBeenCalledWith('Failed to delete "demo"', ["delete failed"]),
    );
    expect(host.graveyardWorktreeDeleteConfirm).toBeNull();
  });

  it("refreshes service state when worktree delete cannot reload the authoritative snapshot", async () => {
    const entry = { name: "demo", path: "/repo/.aimux/worktrees/demo" };
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      graveyardWorktreeDeleteConfirm: entry,
      dashboardState: { toggleDetailsSidebar: vi.fn() },
      isDashboardScreen: vi.fn((screen: string) => screen === "graveyard"),
      getFromProjectService: vi.fn(async () => ({ ok: true, entries: [], worktrees: [] })),
      refreshDashboardModelFromService: vi.fn(async () => true),
      handleDashboardSubscreenNavigationKey: vi.fn(() => false),
      exitDashboardClientOrProcess: vi.fn(),
      setDashboardScreen: vi.fn(),
      renderDashboard: vi.fn(),
      showHelp: vi.fn(),
      showDashboardError: vi.fn(),
    };

    handleGraveyardKey(host, Buffer.from("y"));

    await vi.waitFor(() =>
      expect(host.showDashboardError).toHaveBeenCalledWith('Failed to delete "demo"', [
        "graveyard snapshot unavailable after delete",
      ]),
    );
    await vi.waitFor(() => expect(host.getFromProjectService).toHaveBeenCalledTimes(2));
    expect(host.refreshDashboardModelFromService).toHaveBeenCalledWith(true);
  });

  it("suppresses stale worktree delete errors after leaving graveyard", async () => {
    let rejectDelete!: (reason: unknown) => void;
    postToProjectService.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectDelete = reject;
        }),
    );
    const entry = { name: "demo", path: "/repo/.aimux/worktrees/demo" };
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      graveyardWorktreeDeleteConfirm: entry,
      dashboardState: { toggleDetailsSidebar: vi.fn() },
      isDashboardScreen: vi.fn((screen: string) => host.mode === "dashboard" && screen === "graveyard"),
      handleDashboardSubscreenNavigationKey: vi.fn(() => false),
      exitDashboardClientOrProcess: vi.fn(),
      setDashboardScreen: vi.fn(),
      renderDashboard: vi.fn(),
      showHelp: vi.fn(),
      showDashboardError: vi.fn(),
    };

    handleGraveyardKey(host, Buffer.from("y"));
    await vi.waitFor(() => expect(postToProjectService).toHaveBeenCalledOnce());
    host.dashboardInputEpoch = 1;
    rejectDelete(new Error("delete failed"));

    await new Promise((resolve) => setImmediate(resolve));
    expect(host.graveyardWorktreeDeleteConfirm).toBe(entry);
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });
});
