import { describe, expect, it, vi } from "vitest";
import { ExposePreviewCache, EXPOSE_PREVIEW_CAPTURE_LINES, getExposePreviewSnapshot } from "./expose-preview-cache.js";
import type { FastControlItem } from "./fast-control.js";

function item(id: string, windowId: string): Pick<FastControlItem, "id" | "target"> {
  return {
    id,
    target: { sessionName: "aimux-test", windowId, windowIndex: 1, windowName: "codex" },
  };
}

describe("ExposePreviewCache", () => {
  it("captures listed targets as preview snapshots", () => {
    const tmux = {
      captureTarget: vi.fn((target) => `output for ${target.windowId}\n`),
    };
    const cache = new ExposePreviewCache({
      projectRoot: "/repo",
      tmux,
      listItems: () => [item("a", "@1"), item("b", "@2")],
      now: () => new Date("2026-07-20T13:00:00.000Z"),
    });

    cache.refreshNow();

    expect(tmux.captureTarget).toHaveBeenCalledWith(expect.objectContaining({ windowId: "@1" }), {
      startLine: -EXPOSE_PREVIEW_CAPTURE_LINES,
      includeEscapes: true,
    });
    expect(cache.get("@1")).toEqual({
      output: "output for @1\n",
      capturedAt: "2026-07-20T13:00:00.000Z",
      source: "capture",
      windowId: "@1",
      startLine: -EXPOSE_PREVIEW_CAPTURE_LINES,
      lineCount: EXPOSE_PREVIEW_CAPTURE_LINES,
    });
  });

  it("keeps the last good snapshot when capture fails", () => {
    const tmux = {
      captureTarget: vi.fn(() => "first output\n"),
    };
    const cache = new ExposePreviewCache({
      projectRoot: "/repo",
      tmux,
      listItems: () => [item("a", "@1")],
      now: () => new Date("2026-07-20T13:00:00.000Z"),
    });

    cache.refreshNow();
    tmux.captureTarget.mockImplementation(() => {
      throw new Error("tmux unavailable");
    });
    cache.refreshNow();

    expect(cache.get("@1")?.output).toBe("first output\n");
  });

  it("registers running caches for daemon global expose responses", () => {
    const cache = new ExposePreviewCache({
      projectRoot: "/repo",
      tmux: { captureTarget: () => "registered output\n" },
      listItems: () => [item("a", "@1")],
      now: () => new Date("2026-07-20T13:00:00.000Z"),
    });

    cache.start();
    try {
      cache.refreshNow();
      expect(getExposePreviewSnapshot("/repo", "@1")?.output).toBe("registered output\n");
      expect(getExposePreviewSnapshot("/repo/../repo", "@1")?.output).toBe("registered output\n");
    } finally {
      cache.stop();
    }
    expect(getExposePreviewSnapshot("/repo", "@1")).toBeUndefined();
  });
});
