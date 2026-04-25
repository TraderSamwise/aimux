import { describe, expect, it, vi } from "vitest";
import { TmuxSessionTransport } from "./session-transport.js";
import { TmuxRuntimeManager, type TmuxTarget } from "./runtime-manager.js";

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
      sendKey: vi.fn(),
      captureTarget: vi.fn().mockReturnValue(""),
      killWindow: vi.fn(),
      renameWindow: vi.fn(),
      openTarget: vi.fn(),
      isInsideTmux: vi.fn().mockReturnValue(false),
      getTargetByWindowId: vi.fn().mockReturnValue(createTarget()),
      isWindowAlive: vi.fn().mockReturnValue(true),
    } as unknown as TmuxRuntimeManager;

    const transport = new TmuxSessionTransport("codex-1", "codex", createTarget(), manager, 80, 24);
    transport.write("hello\r");
    transport.write("one\ntwo");

    expect((manager.sendText as any).mock.calls).toEqual([
      [createTarget(), "hello"],
      [createTarget(), "one"],
      [createTarget(), "two"],
    ]);
    expect((manager.sendEnter as any).mock.calls).toEqual([[createTarget()]]);
    expect((manager.sendKey as any).mock.calls).toEqual([[createTarget(), "C-j"]]);
    transport.destroy();
  });

  it("marks exit when the tmux window disappears", () => {
    vi.useFakeTimers();
    const manager = {
      sendText: vi.fn(),
      sendEnter: vi.fn(),
      sendKey: vi.fn(),
      captureTarget: vi.fn().mockReturnValue(""),
      killWindow: vi.fn(),
      renameWindow: vi.fn(),
      openTarget: vi.fn(),
      isInsideTmux: vi.fn().mockReturnValue(false),
      getTargetByWindowId: vi.fn().mockReturnValueOnce(createTarget()).mockReturnValueOnce(null),
      isWindowAlive: vi.fn().mockReturnValue(true),
    } as unknown as TmuxRuntimeManager;

    const transport = new TmuxSessionTransport("codex-1", "codex", createTarget(), manager, 80, 24);
    const onExit = vi.fn();
    transport.onExit(onExit);
    vi.advanceTimersByTime(3200);
    expect(onExit).toHaveBeenCalledWith(0);
    transport.destroy();
    vi.useRealTimers();
  });

  it("marks exit when the tmux pane is dead but the window still exists", () => {
    vi.useFakeTimers();
    const manager = {
      sendText: vi.fn(),
      sendEnter: vi.fn(),
      sendKey: vi.fn(),
      captureTarget: vi.fn().mockReturnValue(""),
      killWindow: vi.fn(),
      renameWindow: vi.fn(),
      openTarget: vi.fn(),
      isInsideTmux: vi.fn().mockReturnValue(false),
      getTargetByWindowId: vi.fn().mockReturnValue(createTarget()),
      isWindowAlive: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false),
    } as unknown as TmuxRuntimeManager;

    const transport = new TmuxSessionTransport("codex-1", "codex", createTarget(), manager, 80, 24);
    const onExit = vi.fn();
    transport.onExit(onExit);
    vi.advanceTimersByTime(3200);
    expect(onExit).toHaveBeenCalledWith(0);
    transport.destroy();
    vi.useRealTimers();
  });

  it("does not mark exit on a single transient unhealthy poll during startup", () => {
    vi.useFakeTimers();
    const manager = {
      sendText: vi.fn(),
      sendEnter: vi.fn(),
      sendKey: vi.fn(),
      captureTarget: vi.fn().mockReturnValue(""),
      killWindow: vi.fn(),
      renameWindow: vi.fn(),
      openTarget: vi.fn(),
      isInsideTmux: vi.fn().mockReturnValue(false),
      getTargetByWindowId: vi
        .fn()
        .mockReturnValue(createTarget())
        .mockReturnValue(createTarget())
        .mockReturnValue(createTarget()),
      isWindowAlive: vi.fn().mockReturnValueOnce(false).mockReturnValue(true).mockReturnValue(true),
    } as unknown as TmuxRuntimeManager;

    const transport = new TmuxSessionTransport("codex-1", "codex", createTarget(), manager, 80, 24);
    const onExit = vi.fn();
    transport.onExit(onExit);
    vi.advanceTimersByTime(3200);
    expect(onExit).not.toHaveBeenCalled();
    transport.destroy();
    vi.useRealTimers();
  });
});
