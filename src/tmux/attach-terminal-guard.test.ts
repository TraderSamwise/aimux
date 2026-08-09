import { describe, expect, it, vi } from "vitest";
import { TmuxRuntimeManager, hasInteractiveTerminal } from "./runtime-manager.js";

describe("hasInteractiveTerminal", () => {
  it("requires both stdin and stdout to be a terminal", () => {
    expect(hasInteractiveTerminal({ stdin: { isTTY: true }, stdout: { isTTY: true } })).toBe(true);
    expect(hasInteractiveTerminal({ stdin: { isTTY: true }, stdout: { isTTY: false } })).toBe(false);
    expect(hasInteractiveTerminal({ stdin: { isTTY: false }, stdout: { isTTY: true } })).toBe(false);
    expect(hasInteractiveTerminal({})).toBe(false);
  });
});

describe("attachSession", () => {
  function managerWithTty(isTTY: boolean, interactiveExec = vi.fn()) {
    const stdin = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const stdout = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: isTTY, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true });
    const restore = () => {
      if (stdin) Object.defineProperty(process.stdin, "isTTY", stdin);
      if (stdout) Object.defineProperty(process.stdout, "isTTY", stdout);
    };
    const manager = new TmuxRuntimeManager(vi.fn(() => "") as never, interactiveExec as never);
    return { manager, interactiveExec, restore };
  }

  it("refuses to attach with no terminal, naming the command to run by hand", () => {
    // Without a terminal `tmux attach-session` never returns, so the caller keeps
    // whatever lock it took forever. Failing fast is the whole point.
    const { manager, interactiveExec, restore } = managerWithTty(false);
    try {
      expect(() => manager.attachSession("aimux-proj", 0)).toThrow(/without a terminal/);
      expect(() => manager.attachSession("aimux-proj", 0)).toThrow(/tmux attach -t aimux-proj:0/);
      expect(interactiveExec).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("attaches normally when a terminal is present", () => {
    const { manager, interactiveExec, restore } = managerWithTty(true);
    try {
      manager.attachSession("aimux-proj", 2);
      expect(interactiveExec).toHaveBeenCalledWith(["attach-session", "-t", "aimux-proj:2"]);
    } finally {
      restore();
    }
  });
});
