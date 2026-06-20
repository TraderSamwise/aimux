import { describe, expect, it, vi } from "vitest";

const renderLibraryScreen = vi.hoisted(() => vi.fn());

vi.mock("../tui/screens/subscreen-renderers.js", () => ({
  renderLibraryScreen,
}));

import { handleLibraryKey, refreshLibrary } from "./library.js";

describe("refreshLibrary", () => {
  it("loads renderer entries from the project service", async () => {
    const entries = [
      {
        id: "plan:codex-1",
        kind: "plan",
        title: "Codex plan",
        path: "/repo/.aimux/plans/codex-1.md",
        updatedAt: "2026-06-20T00:00:00.000Z",
        sessionId: "codex-1",
        label: "Codex plan",
        preview: "# Plan",
      },
    ];
    const host: any = {
      libraryIndex: -1,
      getFromProjectService: vi.fn(async () => ({ ok: true, entries })),
    };

    await expect(refreshLibrary(host)).resolves.toBe(true);

    expect(host.getFromProjectService).toHaveBeenCalledWith("/library");
    expect(host.libraryEntries).toBe(entries);
    expect(host.libraryIndex).toBe(0);
  });

  it("initializes an empty list instead of building from local stores on invalid payloads", async () => {
    const host: any = {
      getSessionLabel: vi.fn(),
      getFromProjectService: vi.fn(async () => ({ ok: true, entries: [{ id: "bad" }] })),
    };

    await expect(refreshLibrary(host)).resolves.toBe(false);

    expect(host.getSessionLabel).not.toHaveBeenCalled();
    expect(host.libraryEntries).toEqual([]);
  });

  it("does not redraw library after manual refresh when the user has navigated away", async () => {
    let resolveRefresh!: (value: unknown) => void;
    const host: any = {
      libraryEntries: [],
      getFromProjectService: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      ),
      isDashboardScreen: vi.fn(() => false),
      handleDashboardSubscreenNavigationKey: vi.fn(() => false),
    };

    handleLibraryKey(host, Buffer.from("r"));
    resolveRefresh({ ok: true, entries: [] });
    await vi.waitFor(() => expect(host.getFromProjectService).toHaveBeenCalledWith("/library"));
    await Promise.resolve();

    expect(renderLibraryScreen).not.toHaveBeenCalled();
  });
});
