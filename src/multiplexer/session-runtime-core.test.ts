import { describe, expect, it, vi, afterEach } from "vitest";

import {
  normalizeAgentInput,
  paneStillContainsAgentDraft,
  resolveLiveSessionTmuxTarget,
  scheduleTmuxAgentSubmit,
} from "./session-runtime-core.js";

describe("session runtime prompt submission", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats Codex pasted-content markers as a still-visible draft", () => {
    const host: any = {
      tmuxRuntimeManager: {
        captureTarget: vi.fn(() => "› [Pasted Content 3434 chars]"),
      },
    };

    expect(
      paneStillContainsAgentDraft(
        host,
        { windowId: "@1" },
        "This is a long aimux task prompt that Codex will collapse into a pasted-content marker.",
      ),
    ).toBe(true);
  });

  it("compacts Codex submitted injections to the single-line shape used by startup kickoff", () => {
    const host: any = {
      sessionToolKeys: new Map([["codex-1", "codex"]]),
    };

    expect(normalizeAgentInput(host, "Aimux task\n\nRun:\n  aimux task show t1\n", true, "codex-1")).toBe(
      "Aimux task Run: aimux task show t1",
    );
  });

  it("preserves multiline submitted injections for non-Codex tools", () => {
    const host: any = {
      sessionToolKeys: new Map([["claude-1", "claude"]]),
    };

    expect(normalizeAgentInput(host, "Aimux task\n\nRun:\n  aimux task show t1\n", true, "claude-1")).toBe(
      "Aimux task\n\nRun:\n  aimux task show t1",
    );
  });

  it("submits agent prompt injection with raw carriage return after the draft is stable", () => {
    vi.useFakeTimers();
    const target = { windowId: "@1" };
    const captures = [
      "› [Pasted Content 3434 chars]",
      "› [Pasted Content 3434 chars]",
      "› [Pasted Content 3434 chars]",
      "› [Pasted Content 3434 chars]",
      "",
    ];
    const host: any = {
      sessionTmuxTargets: new Map([["codex-1", target]]),
      tmuxRuntimeManager: {
        captureTarget: vi.fn(() => captures.shift() ?? ""),
        sendCarriageReturn: vi.fn(),
        sendEnter: vi.fn(),
      },
    };

    scheduleTmuxAgentSubmit(host, "codex-1", target, "Review task details and respond through aimux.");

    vi.advanceTimersByTime(300);
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(200);

    expect(host.tmuxRuntimeManager.sendCarriageReturn).toHaveBeenCalledWith(target);
    expect(host.tmuxRuntimeManager.sendEnter).not.toHaveBeenCalled();
  });

  it("allows a live just-created tmux target before metadata has been written", () => {
    const target = { sessionName: "aimux-test", windowId: "@1", windowIndex: 1, windowName: "claude" };
    const resolved = { ...target, windowIndex: 2 };
    const host: any = {
      sessionTmuxTargets: new Map([["claude-1", target]]),
      tmuxRuntimeManager: {
        getTargetByWindowId: vi.fn(() => resolved),
        getWindowMetadata: vi.fn(() => null),
      },
    };

    expect(resolveLiveSessionTmuxTarget(host, "claude-1")).toEqual(resolved);
    expect(host.sessionTmuxTargets.get("claude-1")).toEqual(resolved);
  });

  it("rejects a cached tmux target when metadata belongs to another session", () => {
    const target = { sessionName: "aimux-test", windowId: "@1", windowIndex: 1, windowName: "claude" };
    const host: any = {
      sessionTmuxTargets: new Map([["claude-1", target]]),
      tmuxRuntimeManager: {
        getTargetByWindowId: vi.fn(() => target),
        getWindowMetadata: vi.fn(() => ({ kind: "agent", sessionId: "claude-other" })),
        listProjectManagedWindows: vi.fn(() => []),
      },
    };

    expect(resolveLiveSessionTmuxTarget(host, "claude-1")).toBeUndefined();
  });
});
