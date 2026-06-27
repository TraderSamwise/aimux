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
      resizeTarget: vi.fn(),
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

  it("resizes the backing tmux window", () => {
    const manager = {
      sendText: vi.fn(),
      sendEnter: vi.fn(),
      sendKey: vi.fn(),
      resizeTarget: vi.fn(),
      captureTarget: vi.fn().mockReturnValue(""),
      killWindow: vi.fn(),
      renameWindow: vi.fn(),
      openTarget: vi.fn(),
      isInsideTmux: vi.fn().mockReturnValue(false),
      getTargetByWindowId: vi.fn().mockReturnValue(createTarget()),
      isWindowAlive: vi.fn().mockReturnValue(true),
    } as unknown as TmuxRuntimeManager;

    const transport = new TmuxSessionTransport("codex-1", "codex", createTarget(), manager, 80, 24);
    transport.resize(100, 32);

    expect((manager.resizeTarget as any).mock.calls).toEqual([[createTarget(), 100, 32]]);
    transport.destroy();
  });

  it("keeps dimensions unchanged when tmux resize fails", () => {
    const manager = {
      sendText: vi.fn(),
      sendEnter: vi.fn(),
      sendKey: vi.fn(),
      resizeTarget: vi.fn(() => {
        throw new Error("missing window");
      }),
      captureTarget: vi.fn().mockReturnValue(""),
      killWindow: vi.fn(),
      renameWindow: vi.fn(),
      openTarget: vi.fn(),
      isInsideTmux: vi.fn().mockReturnValue(false),
      getTargetByWindowId: vi.fn().mockReturnValue(createTarget()),
      isWindowAlive: vi.fn().mockReturnValue(true),
    } as unknown as TmuxRuntimeManager;

    const transport = new TmuxSessionTransport("codex-1", "codex", createTarget(), manager, 80, 24);

    expect(() => transport.resize(100, 32)).toThrow("missing window");
    expect((transport as any).cols).toBe(80);
    expect((transport as any).rows).toBe(24);
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
    vi.advanceTimersByTime(30_000);
    expect(onExit).toHaveBeenCalledWith(0);
    expect(manager.isWindowAlive as any).not.toHaveBeenCalled();
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
      getTargetByWindowId: vi
        .fn()
        .mockReturnValueOnce(createTarget())
        .mockReturnValueOnce({
          ...createTarget(),
          paneDead: true,
        }),
      isWindowAlive: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false),
    } as unknown as TmuxRuntimeManager;

    const transport = new TmuxSessionTransport("codex-1", "codex", createTarget(), manager, 80, 24);
    const onExit = vi.fn();
    transport.onExit(onExit);
    vi.advanceTimersByTime(30_000);
    expect(onExit).toHaveBeenCalledWith(0);
    expect(manager.isWindowAlive as any).not.toHaveBeenCalled();
    transport.destroy();
    vi.useRealTimers();
  });
});
