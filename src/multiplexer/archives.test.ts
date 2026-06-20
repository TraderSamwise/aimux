import { describe, expect, it, vi } from "vitest";

const renderGraveyardScreen = vi.hoisted(() => vi.fn());
const postToProjectService = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

vi.mock("../tui/screens/subscreen-renderers.js", () => ({
  renderGraveyardDetails: vi.fn(() => []),
  renderGraveyardScreen,
}));

vi.mock("./dashboard-control.js", () => ({
  postToProjectService,
}));

import { refreshGraveyardEntriesFromService, resurrectGraveyardEntry } from "./archives.js";

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
});

describe("resurrectGraveyardEntry", () => {
  it("posts the mutation and refreshes graveyard state from the service", async () => {
    const initial = graveyardPayload();
    const refreshed = { ok: true, entries: [], worktrees: [], viewModel: { rows: [], selectableRows: [] } };
    const host: any = {
      mode: "dashboard",
      activeIndex: 0,
      graveyardIndex: 0,
      graveyardViewModel: initial.viewModel,
      getFromProjectService: vi.fn(async () => refreshed),
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

    expect(host.listGraveyardEntries).not.toHaveBeenCalled();
    expect(host.listWorktreeGraveyardEntries).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(host.setDashboardScreen).toHaveBeenCalledWith("dashboard"));
    expect(host.renderDashboard).toHaveBeenCalled();
  });
});
