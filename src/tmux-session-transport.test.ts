import { describe, expect, it, vi } from "vitest";
import { TmuxSessionTransport } from "./tmux-session-transport.js";
import { TmuxRuntimeManager, type TmuxTarget } from "./tmux-runtime-manager.js";

function createTarget(): TmuxTarget {
  return {
    sessionName: "aimux-mobile-abc",
    windowId: "@3",
    windowIndex: 3,
    windowName: "codex",
  };
}

describe("TmuxSessionTransport", () => {
  it("sends text and enter keys through tmux", () => {
    const manager = {
      sendText: vi.fn(),
      sendEnter: vi.fn(),
      captureTarget: vi.fn().mockReturnValue(""),
      killWindow: vi.fn(),
      renameWindow: vi.fn(),
      openTarget: vi.fn(),
      isInsideTmux: vi.fn().mockReturnValue(false),
      getTargetByWindowId: vi.fn().mockReturnValue(createTarget()),
    } as unknown as TmuxRuntimeManager;

    const transport = new TmuxSessionTransport("codex-1", "codex", createTarget(), manager, 80, 24);
    transport.write("hello\r");
    transport.write("one\ntwo");

    expect((manager.sendText as any).mock.calls).toEqual([
      [createTarget(), "hello"],
      [createTarget(), "one"],
      [createTarget(), "two"],
    ]);
    expect((manager.sendEnter as any).mock.calls.length).toBe(3);
    transport.destroy();
  });

  it("marks exit when the tmux window disappears", () => {
    vi.useFakeTimers();
    const manager = {
      sendText: vi.fn(),
      sendEnter: vi.fn(),
      captureTarget: vi.fn().mockReturnValue(""),
      killWindow: vi.fn(),
      renameWindow: vi.fn(),
      openTarget: vi.fn(),
      isInsideTmux: vi.fn().mockReturnValue(false),
      getTargetByWindowId: vi.fn().mockReturnValueOnce(createTarget()).mockReturnValueOnce(null),
    } as unknown as TmuxRuntimeManager;

    const transport = new TmuxSessionTransport("codex-1", "codex", createTarget(), manager, 80, 24);
    const onExit = vi.fn();
    transport.onExit(onExit);
    vi.advanceTimersByTime(2200);
    expect(onExit).toHaveBeenCalledWith(0);
    transport.destroy();
    vi.useRealTimers();
  });
});
