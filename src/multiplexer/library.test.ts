import { describe, expect, it, vi } from "vitest";

const renderLibraryScreen = vi.hoisted(() => vi.fn());

vi.mock("../tui/screens/subscreen-renderers.js", () => ({
  renderLibraryScreen,
}));

import { handleLibraryKey, refreshLibrary } from "./library.js";

describe("refreshLibrary", () => {
  function libraryEntry(id = "plan:codex-1") {
    return {
      id,
      kind: "plan",
      title: "Codex plan",
      path: "/repo/.aimux/plans/codex-1.md",
      updatedAt: "2026-06-20T00:00:00.000Z",
      sessionId: "codex-1",
      label: "Codex plan",
      preview: "# Plan",
    };
  }

  it("loads renderer entries from the project service", async () => {
    const entries = [libraryEntry()];
    const host: any = {
      libraryIndex: -1,
      getFromProjectService: vi.fn(async () => ({ ok: true, entries })),
    };

    await expect(refreshLibrary(host)).resolves.toBe(true);

    expect(host.getFromProjectService).toHaveBeenCalledWith("/library");
    expect(host.libraryEntries).toBe(entries);
    expect(host.libraryLoaded).toBe(true);
    expect(host.libraryIndex).toBe(0);
  });

  it("coalesces concurrent library refreshes through the TUI API runtime", async () => {
    const entries = [libraryEntry()];
    let resolveRefresh!: (value: unknown) => void;
    const host: any = {
      libraryIndex: -1,
      getFromProjectService: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      ),
    };

    const first = refreshLibrary(host);
    const second = refreshLibrary(host);
    resolveRefresh({ ok: true, entries });

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);

    expect(host.getFromProjectService).toHaveBeenCalledTimes(1);
    expect(host.libraryEntries).toBe(entries);
  });

  it("initializes an empty list instead of building from local stores on invalid payloads", async () => {
    const host: any = {
      getSessionLabel: vi.fn(),
      getFromProjectService: vi.fn(async () => ({ ok: true, entries: [{ id: "bad" }] })),
    };

    await expect(refreshLibrary(host)).resolves.toBe(false);

    expect(host.getSessionLabel).not.toHaveBeenCalled();
    expect(host.libraryLoaded).toBe(true);
    expect(host.libraryEntries).toEqual([]);
  });

  it("preserves loaded entries when a refresh payload is invalid", async () => {
    const entries = [libraryEntry("plan:keep")];
    const host: any = {
      libraryEntries: entries,
      libraryLoaded: true,
      libraryIndex: 0,
      getFromProjectService: vi.fn(async () => ({ ok: true, entries: [{ id: "bad" }] })),
    };

    await expect(refreshLibrary(host)).resolves.toBe(false);

    expect(host.libraryEntries).toBe(entries);
    expect(host.libraryEntries[0].id).toBe("plan:keep");
  });

  it("preserves loaded entries when the service request rejects", async () => {
    const entries = [libraryEntry("plan:keep")];
    const host: any = {
      libraryEntries: entries,
      libraryLoaded: true,
      getFromProjectService: vi.fn(async () => {
        throw new Error("offline");
      }),
    };

    await expect(refreshLibrary(host)).resolves.toBe(false);

    expect(host.libraryEntries).toBe(entries);
  });

  it("applies a valid empty list over previously loaded entries", async () => {
    const entries = [libraryEntry("plan:old")];
    const host: any = {
      libraryEntries: entries,
      libraryLoaded: true,
      getFromProjectService: vi.fn(async () => ({ ok: true, entries: [] })),
    };

    await expect(refreshLibrary(host)).resolves.toBe(true);

    expect(host.libraryEntries).toEqual([]);
    expect(host.libraryEntries).not.toBe(entries);
  });

  it("does not redraw library after manual refresh when the user has navigated away", async () => {
    const host: any = {
      libraryEntries: [],
      getFromProjectService: vi.fn(async () => ({ ok: true, entries: [] })),
      isDashboardScreen: vi.fn(() => false),
      handleDashboardSubscreenNavigationKey: vi.fn(() => false),
    };

    handleLibraryKey(host, Buffer.from("r"));
    await Promise.resolve();

    expect(host.getFromProjectService).not.toHaveBeenCalled();
    expect(renderLibraryScreen).not.toHaveBeenCalled();
  });

  it("keeps the old entries when a pending lifecycle refresh completes after navigation", async () => {
    let resolveRefresh!: (value: unknown) => void;
    const previous = [libraryEntry("plan:old")];
    const next = [libraryEntry("plan:new")];
    const host: any = {
      dashboardInputEpoch: 1,
      libraryEntries: previous,
      libraryLoaded: true,
      getFromProjectService: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      ),
    };

    const refresh = refreshLibrary(host, {
      lifecycle: { mode: "dashboard", inputEpoch: 1, requiresInputEpoch: true },
    });
    host.dashboardInputEpoch = 2;
    resolveRefresh({ ok: true, entries: next });

    await expect(refresh).resolves.toBe(false);
    expect(host.libraryEntries).toBe(previous);
  });

  it("redraws library after manual refresh when input changes but the screen stays active", async () => {
    vi.clearAllMocks();
    let resolveRefresh!: (value: unknown) => void;
    const host: any = {
      dashboardInputEpoch: 1,
      libraryEntries: [],
      getFromProjectService: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      ),
      isDashboardScreen: vi.fn((screen: string) => screen === "library"),
      handleDashboardSubscreenNavigationKey: vi.fn(() => false),
    };

    handleLibraryKey(host, Buffer.from("r"));
    host.dashboardInputEpoch = 2;
    resolveRefresh({ ok: true, entries: [] });

    await vi.waitFor(() => expect(renderLibraryScreen).toHaveBeenCalled());
  });

  it("shows the selected entry path instead of spawning an editor", () => {
    vi.clearAllMocks();
    const entry = libraryEntry("plan:selected");
    const host: any = {
      libraryEntries: [entry],
      libraryLoaded: true,
      libraryIndex: 0,
      handleDashboardSubscreenNavigationKey: vi.fn(() => false),
    };

    handleLibraryKey(host, Buffer.from("\r"));

    expect(host.libraryPathFlash).toBe(entry.path);
    expect(renderLibraryScreen).toHaveBeenCalledOnce();
  });
});
