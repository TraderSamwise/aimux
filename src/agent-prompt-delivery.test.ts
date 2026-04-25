import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deliverTmuxPrompt,
  normalizeSubmittedPrompt,
  paneStillContainsPromptDraft,
  scheduleTmuxPromptSubmit,
} from "./agent-prompt-delivery.js";

const target = {
  sessionName: "aimux-test",
  windowId: "@1",
  windowIndex: 1,
  windowName: "codex",
};

describe("agent prompt delivery", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("normalizes submitted Codex prompts to the reliable single-line shape", () => {
    expect(normalizeSubmittedPrompt("codex", "Aimux task\n\nRun:\n  aimux task show t1\n", true)).toBe(
      "Aimux task Run: aimux task show t1",
    );
  });

  it("preserves multiline submitted prompts for non-Codex tools", () => {
    expect(normalizeSubmittedPrompt("claude", "Aimux task\n\nRun:\n  aimux task show t1\n", true)).toBe(
      "Aimux task\n\nRun:\n  aimux task show t1",
    );
  });

  it("detects Codex pasted-content markers as visible drafts", () => {
    const tmuxRuntimeManager = {
      captureTarget: vi.fn(() => "› [Pasted Content 3434 chars]"),
      sendCarriageReturn: vi.fn(),
      sendText: vi.fn(),
    };

    expect(
      paneStillContainsPromptDraft(
        tmuxRuntimeManager,
        target,
        "This is a long aimux task prompt that Codex will collapse into a pasted-content marker.",
      ),
    ).toBe(true);
  });

  it("submits after the draft has appeared and stabilized", () => {
    vi.useFakeTimers();
    const captures = [
      "› [Pasted Content 3434 chars]",
      "› [Pasted Content 3434 chars]",
      "› [Pasted Content 3434 chars]",
      "› [Pasted Content 3434 chars]",
      "",
    ];
    const tmuxRuntimeManager = {
      captureTarget: vi.fn(() => captures.shift() ?? ""),
      sendCarriageReturn: vi.fn(),
      sendText: vi.fn(),
    };

    scheduleTmuxPromptSubmit({
      tmuxRuntimeManager,
      target,
      draft: "Review task details and respond through aimux.",
      isTargetCurrent: () => true,
    });

    vi.advanceTimersByTime(300);
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(200);

    expect(tmuxRuntimeManager.sendCarriageReturn).toHaveBeenCalledWith(target);
  });

  it("sends text and uses the shared submit path for submitted tmux prompts", async () => {
    vi.useFakeTimers();
    const captures = [
      "› [Pasted Content 3434 chars]",
      "› [Pasted Content 3434 chars]",
      "› [Pasted Content 3434 chars]",
      "› [Pasted Content 3434 chars]",
      "",
    ];
    const tmuxRuntimeManager = {
      captureTarget: vi.fn(() => captures.shift() ?? ""),
      sendCarriageReturn: vi.fn(),
      sendText: vi.fn(),
    };

    const delivered = deliverTmuxPrompt({
      tmuxRuntimeManager,
      target,
      prompt: "Review task details and respond through aimux.",
      submit: true,
      isTargetCurrent: () => true,
    });

    vi.advanceTimersByTime(300);
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(200);
    vi.advanceTimersByTime(700);

    await expect(delivered).resolves.toBe(true);
    expect(tmuxRuntimeManager.sendText).toHaveBeenCalledWith(target, "Review task details and respond through aimux.");
    expect(tmuxRuntimeManager.sendCarriageReturn).toHaveBeenCalledWith(target);
  });
});
