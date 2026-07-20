import { afterEach, describe, expect, it, vi } from "vitest";
import { ExposePreviewCache, EXPOSE_PREVIEW_CAPTURE_LINES, getExposePreviewSnapshot } from "./expose-preview-cache.js";
import type { FastControlItem } from "./fast-control.js";

function item(id: string, windowId: string): Pick<FastControlItem, "id" | "target"> {
  return {
    id,
    target: { sessionName: "aimux-test", windowId, windowIndex: 1, windowName: "codex" },
  };
}

describe("ExposePreviewCache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("captures listed targets as preview snapshots", async () => {
    const tmux = {
      captureTargetAsync: vi.fn(async (target) => `output for ${target.windowId}\n`),
    };
    const cache = new ExposePreviewCache({
      projectRoot: "/repo",
      tmux,
      listItems: () => [item("a", "@1"), item("b", "@2")],
      now: () => new Date("2026-07-20T13:00:00.000Z"),
    });

    cache.start();
    try {
      cache.trackItems([item("a", "@1")]);
      await cache.refreshNow();
    } finally {
      cache.stop();
    }

    expect(tmux.captureTargetAsync).toHaveBeenCalledWith(expect.objectContaining({ windowId: "@1" }), {
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

  it("keeps the last good snapshot when capture fails", async () => {
    const tmux = {
      captureTargetAsync: vi.fn(async () => "first output\n"),
    };
    const cache = new ExposePreviewCache({
      projectRoot: "/repo",
      tmux,
      listItems: () => [item("a", "@1")],
      now: () => new Date("2026-07-20T13:00:00.000Z"),
    });

    cache.start();
    try {
      cache.trackItems([item("a", "@1")]);
      await cache.refreshNow();
      tmux.captureTargetAsync.mockImplementation(async () => {
        throw new Error("tmux unavailable");
      });
      await cache.refreshNow();
    } finally {
      cache.stop();
    }

    expect(cache.get("@1")?.output).toBe("first output\n");
  });

  it("does not capture until demanded and stops scheduling after the active window", async () => {
    vi.useFakeTimers();
    const tmux = {
      captureTargetAsync: vi.fn(async (target) => `output for ${target.windowId}\n`),
    };
    const cache = new ExposePreviewCache({
      projectRoot: "/repo",
      tmux,
      listItems: () => [item("a", "@1")],
      intervalMs: 1000,
      activeMs: 1500,
      now: () => new Date(Date.now()),
    });

    cache.start();
    try {
      vi.advanceTimersByTime(5000);
      expect(tmux.captureTargetAsync).not.toHaveBeenCalled();

      cache.trackItems([item("a", "@1")]);
      await vi.runOnlyPendingTimersAsync();
      expect(tmux.captureTargetAsync).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(tmux.captureTargetAsync).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1000);
      expect(tmux.captureTargetAsync).toHaveBeenCalledTimes(2);
    } finally {
      cache.stop();
    }
  });

  it("prunes tracked targets and snapshots that are no longer listed", async () => {
    let liveItems = [item("a", "@1")];
    const cache = new ExposePreviewCache({
      projectRoot: "/repo",
      tmux: { captureTargetAsync: async () => "first output\n" },
      listItems: () => liveItems,
      now: () => new Date("2026-07-20T13:00:00.000Z"),
    });

    cache.start();
    try {
      cache.trackItems([item("a", "@1")]);
      await cache.refreshNow();
      expect(cache.get("@1")?.output).toBe("first output\n");

      liveItems = [];
      await cache.refreshNow();
      expect(cache.get("@1")).toBeUndefined();
    } finally {
      cache.stop();
    }
  });

  it("evicts tracked targets after repeated capture failures", async () => {
    const tmux = {
      captureTargetAsync: vi.fn(async () => {
        throw new Error("tmux unavailable");
      }),
    };
    const cache = new ExposePreviewCache({
      projectRoot: "/repo",
      tmux,
      listItems: () => {
        throw new Error("list unavailable");
      },
      now: () => new Date("2026-07-20T13:00:00.000Z"),
    });

    cache.start();
    try {
      cache.trackItems([item("a", "@1")]);
      await cache.refreshNow();
      await cache.refreshNow();
      await cache.refreshNow();
      await cache.refreshNow();

      expect(tmux.captureTargetAsync).toHaveBeenCalledTimes(3);
      expect(cache.get("@1")).toBeUndefined();
    } finally {
      cache.stop();
    }
  });

  it("registers running caches for daemon global expose responses", async () => {
    const cache = new ExposePreviewCache({
      projectRoot: "/repo",
      tmux: { captureTargetAsync: async () => "registered output\n" },
      listItems: () => [item("a", "@1")],
      now: () => new Date("2026-07-20T13:00:00.000Z"),
    });

    cache.start();
    try {
      cache.trackItems([item("a", "@1")]);
      await cache.refreshNow();
      expect(getExposePreviewSnapshot("/repo", "@1")?.output).toBe("registered output\n");
      expect(getExposePreviewSnapshot("/repo/../repo", "@1")?.output).toBe("registered output\n");
    } finally {
      cache.stop();
    }
    expect(getExposePreviewSnapshot("/repo", "@1")).toBeUndefined();
  });
});
