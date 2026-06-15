import { describe, expect, it, vi } from "vitest";
import type { execFile as NodeExecFile } from "node:child_process";
import {
  buildDesktopNotifierDoctorReport,
  findMacNotifierHelper,
  macNotifierCandidates,
  renderDesktopNotifierDoctorReport,
  sendDesktopNotification,
  type DesktopNotifierDeps,
} from "./desktop-notifier.js";

type ExecFile = typeof NodeExecFile;

function execFileMock(error: Error | null = null, stdout = "", stderr = ""): ExecFile {
  return vi.fn(
    (
      _file: string,
      _args: readonly string[],
      optionsOrCallback?: { timeout?: number } | ((error: Error | null, stdout?: string, stderr?: string) => void),
      callback?: (error: Error | null, stdout?: string, stderr?: string) => void,
    ) => {
      const cb = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      cb?.(error, stdout, stderr);
    },
  ) as unknown as ExecFile;
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
      `/tmp/aimux/native/darwin-${process.arch}/aimux-notifier.app/Contents/MacOS/aimux-notifier`,
      "/tmp/aimux/native/darwin/aimux-notifier",
      `/tmp/aimux/native/darwin-${process.arch}/aimux-notifier`,
    ]);
  });

  it("derives npm-packaged macOS helper candidates for the current architecture", () => {
    expect(macNotifierCandidates(deps({ arch: "x64" }))).toEqual([
      "/tmp/aimux/native/darwin/aimux-notifier.app/Contents/MacOS/aimux-notifier",
      "/tmp/aimux/native/darwin-x64/aimux-notifier.app/Contents/MacOS/aimux-notifier",
      "/tmp/aimux/native/darwin/aimux-notifier",
      "/tmp/aimux/native/darwin-x64/aimux-notifier",
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

  it("does not fall back to node-notifier when the macOS helper reports failure", () => {
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

    expect(nodeNotifier.notify).not.toHaveBeenCalled();
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

  it("builds a macOS doctor report with helper check output", async () => {
    const report = await buildDesktopNotifierDoctorReport(
      deps({
        env: { AIMUX_NOTIFIER_HELPER: "/tmp/aimux-notifier" },
        existsSync: vi.fn((candidate) => candidate === "/tmp/aimux-notifier"),
        execFile: execFileMock(null, "Aimux notifier ready (app.aimux.notifier)\n"),
      }),
    );

    expect(report).toMatchObject({
      platform: "darwin",
      transport: "mac-helper",
      helperPath: "/tmp/aimux-notifier",
      helperCheck: {
        ok: true,
        exitCode: 0,
        stdout: "Aimux notifier ready (app.aimux.notifier)",
        stderr: "",
      },
    });
  });

  it("builds a macOS doctor report for denied helper authorization", async () => {
    const error = Object.assign(new Error("Command failed: notifications are denied"), { code: 77 });
    const report = await buildDesktopNotifierDoctorReport(
      deps({
        env: { AIMUX_NOTIFIER_HELPER: "/tmp/aimux-notifier" },
        existsSync: vi.fn((candidate) => candidate === "/tmp/aimux-notifier"),
        execFile: execFileMock(error, "Aimux notifier ready (app.aimux.notifier); authorization=denied\n"),
      }),
    );

    expect(report).toMatchObject({
      platform: "darwin",
      transport: "mac-helper",
      helperPath: "/tmp/aimux-notifier",
      helperCheck: {
        ok: false,
        exitCode: 77,
        stdout: "Aimux notifier ready (app.aimux.notifier); authorization=denied",
      },
    });
  });

  it("renders missing helper candidates in the doctor report", () => {
    const output = renderDesktopNotifierDoctorReport({
      platform: "darwin",
      transport: "node-notifier",
      helperPath: null,
      helperCandidates: ["/tmp/one", "/tmp/two"],
    });

    expect(output).toContain("Helper: not found");
    expect(output).toContain("Checked:\n  /tmp/one\n  /tmp/two");
  });
});
