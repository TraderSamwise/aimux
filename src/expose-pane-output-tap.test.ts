import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ExposePaneOutputTap } from "./expose-pane-output-tap.js";
import type { FastControlItem } from "./fast-control.js";

function item(
  id: string,
  windowId: string,
  target: Partial<FastControlItem["target"]> = {},
): Pick<FastControlItem, "id" | "target"> {
  return {
    id,
    target: { sessionName: "aimux-test", windowId, windowIndex: 1, windowName: "codex", ...target },
  };
}

function tapFiles(projectStateDir: string): string[] {
  const tapDir = join(projectStateDir, "expose-pane-taps");
  if (!existsSync(tapDir)) return [];
  return readdirSync(tapDir)
    .filter((entry) => entry.endsWith(".log"))
    .map((entry) => join(tapDir, entry));
}

function tokenFiles(projectStateDir: string): string[] {
  const tapDir = join(projectStateDir, "expose-pane-taps");
  if (!existsSync(tapDir)) return [];
  return readdirSync(tapDir)
    .filter((entry) => entry.endsWith(".token"))
    .map((entry) => join(tapDir, entry));
}

function markOwned(options?: { ownership?: { token: string; tokenFilePath: string } }): void {
  if (options?.ownership) writeFileSync(options.ownership.tokenFilePath, `${options.ownership.token}\n`);
}

describe("ExposePaneOutputTap", () => {
  let projectStateDir = "";

  afterEach(() => {
    vi.useRealTimers();
    if (projectStateDir) rmSync(projectStateDir, { recursive: true, force: true });
    projectStateDir = "";
  });

  it("starts a tmux pipe and reads the latest tap output", () => {
    projectStateDir = mkdtempSync(join(tmpdir(), "aimux-expose-tap-"));
    const tmux = {
      isPanePiped: vi.fn(() => false),
      pipeTargetToFile: vi.fn((target: FastControlItem["target"], filePath: string, options?: any) => {
        markOwned(options);
        writeFileSync(filePath, `output for ${target.windowId}\n`);
      }),
      stopPanePipe: vi.fn(),
    };
    const tap = new ExposePaneOutputTap({
      projectStateDir,
      tmux,
      now: () => new Date("2026-07-20T13:00:00.000Z"),
    });

    tap.start();
    tap.trackItems([item("a", "@1")]);
    const snapshot = tap.read("@1");

    expect(tmux.isPanePiped).toHaveBeenCalledWith(expect.objectContaining({ windowId: "@1" }));
    expect(tmux.pipeTargetToFile).toHaveBeenCalledWith(
      expect.objectContaining({ windowId: "@1" }),
      expect.stringContaining("expose-pane-taps"),
      expect.objectContaining({
        onlyIfNotPiped: true,
        ownership: expect.objectContaining({ token: expect.any(String), tokenFilePath: expect.any(String) }),
      }),
    );
    expect(snapshot).toEqual({
      output: "output for @1\n",
      capturedAt: "2026-07-20T13:00:00.000Z",
      source: "tap",
      windowId: "@1",
      byteCount: Buffer.byteLength("output for @1\n"),
    });
    expect(tapFiles(projectStateDir)).toHaveLength(1);

    tap.stop();
    expect(tmux.stopPanePipe).toHaveBeenCalledWith(expect.objectContaining({ windowId: "@1" }));
    expect(tapFiles(projectStateDir)).toHaveLength(0);
  });

  it("does not restart an already tracked target while demand is renewed", () => {
    projectStateDir = mkdtempSync(join(tmpdir(), "aimux-expose-tap-"));
    let nowMs = Date.parse("2026-07-20T13:00:00.000Z");
    const tmux = {
      isPanePiped: vi.fn(() => false),
      pipeTargetToFile: vi.fn((target: FastControlItem["target"], filePath: string, options?: any) => {
        markOwned(options);
        writeFileSync(filePath, `output for ${target.windowId}\n`);
      }),
      stopPanePipe: vi.fn(),
    };
    const tap = new ExposePaneOutputTap({
      projectStateDir,
      tmux,
      activeMs: 1000,
      now: () => new Date(nowMs),
    });

    tap.start();
    tap.trackItems([item("a", "@1")]);
    nowMs += 500;
    tap.trackItems([item("a-fresh", "@1")]);

    expect(tmux.pipeTargetToFile).toHaveBeenCalledTimes(1);
    expect(tmux.stopPanePipe).not.toHaveBeenCalled();
    expect(tap.read("@1")?.output).toBe("output for @1\n");
  });

  it("skips panes that are already piped so stop only detaches owned taps", () => {
    projectStateDir = mkdtempSync(join(tmpdir(), "aimux-expose-tap-"));
    const tmux = {
      isPanePiped: vi.fn(() => true),
      pipeTargetToFile: vi.fn(),
      stopPanePipe: vi.fn(),
    };
    const tap = new ExposePaneOutputTap({ projectStateDir, tmux });

    tap.start();
    tap.trackItems([item("a", "@1")]);
    tap.stop();

    expect(tmux.pipeTargetToFile).not.toHaveBeenCalled();
    expect(tmux.stopPanePipe).not.toHaveBeenCalled();
    expect(tap.read("@1")).toBeUndefined();
  });

  it("expires demand and stops active pane pipes", async () => {
    vi.useFakeTimers();
    projectStateDir = mkdtempSync(join(tmpdir(), "aimux-expose-tap-"));
    const tmux = {
      isPanePiped: vi.fn(() => false),
      pipeTargetToFile: vi.fn((target: FastControlItem["target"], filePath: string, options?: any) => {
        markOwned(options);
        writeFileSync(filePath, `output for ${target.windowId}\n`);
      }),
      stopPanePipe: vi.fn(),
    };
    const tap = new ExposePaneOutputTap({
      projectStateDir,
      tmux,
      activeMs: 1000,
      now: () => new Date(Date.now()),
    });

    tap.start();
    tap.trackItems([item("a", "@1")]);
    await vi.advanceTimersByTimeAsync(1001);

    expect(tmux.stopPanePipe).toHaveBeenCalledWith(expect.objectContaining({ windowId: "@1" }));
    expect(tap.read("@1")).toBeUndefined();
    expect(tapFiles(projectStateDir)).toHaveLength(0);
  });

  it("reads and compacts bounded tap files", () => {
    projectStateDir = mkdtempSync(join(tmpdir(), "aimux-expose-tap-"));
    const tmux = {
      isPanePiped: vi.fn(() => false),
      pipeTargetToFile: vi.fn((_target: FastControlItem["target"], filePath: string, options?: any) => {
        markOwned(options);
        writeFileSync(filePath, "0123456789");
      }),
      stopPanePipe: vi.fn(),
    };
    const tap = new ExposePaneOutputTap({ projectStateDir, tmux, maxBytes: 5 });

    tap.start();
    tap.trackItems([item("a", "@1")]);
    const snapshot = tap.read("@1");
    const [filePath] = tapFiles(projectStateDir);

    expect(snapshot?.output).toBe("56789");
    expect(snapshot?.byteCount).toBe(5);
    expect(readFileSync(filePath!, "utf8")).toBe("56789");
  });

  it("compacts active tap files during maintenance without reads", async () => {
    vi.useFakeTimers();
    projectStateDir = mkdtempSync(join(tmpdir(), "aimux-expose-tap-"));
    const tmux = {
      isPanePiped: vi.fn(() => false),
      pipeTargetToFile: vi.fn((_target: FastControlItem["target"], filePath: string, options?: any) => {
        markOwned(options);
        writeFileSync(filePath, "0123456789");
      }),
      stopPanePipe: vi.fn(),
    };
    const tap = new ExposePaneOutputTap({
      projectStateDir,
      tmux,
      activeMs: 1000,
      maintenanceMs: 100,
      maxBytes: 5,
      now: () => new Date(Date.now()),
    });

    tap.start();
    tap.trackItems([item("a", "@1")]);
    const [filePath] = tapFiles(projectStateDir);
    expect(readFileSync(filePath!, "utf8")).toBe("0123456789");

    await vi.advanceTimersByTimeAsync(100);

    expect(readFileSync(filePath!, "utf8")).toBe("56789");
    expect(tmux.stopPanePipe).not.toHaveBeenCalled();
  });

  it("does not stop a pane pipe after ownership is lost", () => {
    projectStateDir = mkdtempSync(join(tmpdir(), "aimux-expose-tap-"));
    const tmux = {
      isPanePiped: vi.fn(() => false),
      pipeTargetToFile: vi.fn((_target: FastControlItem["target"], filePath: string, options?: any) => {
        markOwned(options);
        writeFileSync(filePath, "output\n");
      }),
      stopPanePipe: vi.fn(),
    };
    const tap = new ExposePaneOutputTap({ projectStateDir, tmux });

    tap.start();
    tap.trackItems([item("a", "@1")]);
    const [tokenPath] = tokenFiles(projectStateDir);
    rmSync(tokenPath!, { force: true });
    tap.stop();

    expect(tmux.stopPanePipe).not.toHaveBeenCalled();
    expect(tapFiles(projectStateDir)).toHaveLength(0);
  });

  it("does not track a pane when starting the pipe fails", () => {
    projectStateDir = mkdtempSync(join(tmpdir(), "aimux-expose-tap-"));
    const tmux = {
      isPanePiped: vi.fn(() => false),
      pipeTargetToFile: vi.fn(() => {
        throw new Error("tmux unavailable");
      }),
      stopPanePipe: vi.fn(),
    };
    const tap = new ExposePaneOutputTap({ projectStateDir, tmux });

    tap.start();
    tap.trackItems([item("a", "@1")]);
    tap.stop();

    expect(tap.read("@1")).toBeUndefined();
    expect(tmux.stopPanePipe).not.toHaveBeenCalled();
    expect(tapFiles(projectStateDir)).toHaveLength(0);
  });
});
