import { describe, expect, it, vi } from "vitest";
import type { execFile as NodeExecFile } from "node:child_process";
import {
  findMacNotifierHelper,
  macNotifierCandidates,
  sendDesktopNotification,
  type DesktopNotifierDeps,
} from "./desktop-notifier.js";

type ExecFile = typeof NodeExecFile;

function execFileMock(error: Error | null = null): ExecFile {
  return vi.fn((_file: string, _args: readonly string[], callback?: (error: Error | null) => void) => {
    callback?.(error);
  }) as unknown as ExecFile;
}

function deps(overrides: Partial<DesktopNotifierDeps> = {}): DesktopNotifierDeps {
  return {
    platform: "darwin",
    env: {},
    moduleDir: "/tmp/aimux/dist",
    existsSync: vi.fn(() => false),
    execFile: execFileMock(),
    nodeNotifier: { notify: vi.fn() },
    ...overrides,
  };
}

describe("desktop notifier", () => {
  it("resolves a macOS helper override before bundled candidates", () => {
    const found = findMacNotifierHelper(
      deps({
        env: { AIMUX_NOTIFIER_HELPER: "/tmp/Aimux Notifier" },
        existsSync: vi.fn((candidate) => candidate === "/tmp/Aimux Notifier"),
      }),
    );

    expect(found).toBe("/tmp/Aimux Notifier");
  });

  it("derives bundled macOS helper candidates from the package root", () => {
    expect(macNotifierCandidates(deps())).toEqual([
      "/tmp/aimux/native/darwin/aimux-notifier.app/Contents/MacOS/aimux-notifier",
      "/tmp/aimux/native/darwin/aimux-notifier",
    ]);
  });

  it("uses the Aimux macOS helper when available", () => {
    const execFile = execFileMock();
    const nodeNotifier = { notify: vi.fn() };

    const result = sendDesktopNotification(
      { title: "aimux", message: "agent waiting", sound: true },
      deps({
        env: { AIMUX_NOTIFIER_HELPER: "/tmp/aimux-notifier" },
        existsSync: vi.fn((candidate) => candidate === "/tmp/aimux-notifier"),
        execFile,
        nodeNotifier,
      }),
    );

    expect(result).toEqual({ transport: "mac-helper", helperPath: "/tmp/aimux-notifier" });
    expect(execFile).toHaveBeenCalledWith(
      "/tmp/aimux-notifier",
      ["--title", "aimux", "--message", "agent waiting", "--sound"],
      expect.any(Function),
    );
    expect(nodeNotifier.notify).not.toHaveBeenCalled();
  });

  it("falls back to node-notifier when no macOS helper is installed", () => {
    const execFile = execFileMock();
    const nodeNotifier = { notify: vi.fn() };

    const result = sendDesktopNotification(
      { title: "aimux", message: "agent waiting", sound: true },
      deps({ execFile, nodeNotifier }),
    );

    expect(result).toEqual({ transport: "node-notifier" });
    expect(execFile).not.toHaveBeenCalled();
    expect(nodeNotifier.notify).toHaveBeenCalledWith({
      title: "aimux",
      message: "agent waiting",
      sound: true,
    });
  });

  it("falls back to node-notifier when the macOS helper fails", () => {
    const nodeNotifier = { notify: vi.fn() };

    sendDesktopNotification(
      { title: "aimux", message: "agent waiting", sound: true },
      deps({
        env: { AIMUX_NOTIFIER_HELPER: "/tmp/aimux-notifier" },
        existsSync: vi.fn((candidate) => candidate === "/tmp/aimux-notifier"),
        execFile: execFileMock(new Error("boom")),
        nodeNotifier,
      }),
    );

    expect(nodeNotifier.notify).toHaveBeenCalledWith({
      title: "aimux",
      message: "agent waiting",
      sound: true,
    });
  });

  it("uses node-notifier directly on non-macOS platforms", () => {
    const execFile = execFileMock();
    const nodeNotifier = { notify: vi.fn() };

    const result = sendDesktopNotification(
      { title: "aimux", message: "agent waiting", sound: true },
      deps({
        platform: "linux",
        env: { AIMUX_NOTIFIER_HELPER: "/tmp/aimux-notifier" },
        existsSync: vi.fn(() => true),
        execFile,
        nodeNotifier,
      }),
    );

    expect(result).toEqual({ transport: "node-notifier" });
    expect(execFile).not.toHaveBeenCalled();
    expect(nodeNotifier.notify).toHaveBeenCalledTimes(1);
  });
});
