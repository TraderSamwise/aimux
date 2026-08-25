import { afterEach, describe, expect, it, vi } from "vitest";

import {
  detectVisiblePromptInputDraft,
  deliverTmuxPrompt,
  normalizeSubmittedPrompt,
  paneStillContainsPromptDraft,
  scheduleTmuxPromptSubmit,
  waitForVisiblePromptInputIdle,
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

  it("normalizes submitted prompts to the reliable single-line shape", () => {
    expect(normalizeSubmittedPrompt("codex", "Aimux task\n\nRun:\n  aimux task show t1\n", true)).toBe(
      "Aimux task Run: aimux task show t1",
    );
    expect(normalizeSubmittedPrompt("claude", "Aimux task\n\nRun:\n  aimux task show t1\n", true)).toBe(
      "Aimux task Run: aimux task show t1",
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

  it("detects non-empty active prompt input near the bottom of the pane", () => {
    expect(
      detectVisiblePromptInputDraft(
        [
          "• Ran yarn test",
          "",
          "────────────────────────────────",
          "",
          "› Write tests for @filename",
          "",
          "  gpt-5.5 high · ~/cs/thegrand",
        ].join("\n"),
      ),
    ).toMatchObject({ marker: "codex", text: "Write tests for @filename" });

    expect(
      detectVisiblePromptInputDraft(
        ["Dropped. Moving on.", "", "✶ Embellishing... (26s)", "", "❯ take the next branch"].join("\n"),
      ),
    ).toMatchObject({ marker: "claude", text: "take the next branch" });
  });

  it("ignores empty prompt input and older transcript prompt-looking lines", () => {
    expect(
      detectVisiblePromptInputDraft(
        [
          "› previous submitted prompt",
          "• Response from the agent",
          "  all done",
          "",
          "›",
          "  gpt-5.5 high · ~/cs/repo",
        ].join("\n"),
      ),
    ).toBeNull();
  });

  it("waits until visible prompt input stops changing", async () => {
    vi.useFakeTimers();
    const captures = [
      "› human draft one\n  gpt-5.5 high",
      "› human draft two\n  gpt-5.5 high",
      "› human draft two\n  gpt-5.5 high",
      "› human draft two\n  gpt-5.5 high",
    ];
    const tmuxRuntimeManager = {
      captureTarget: vi.fn(() => captures.shift() ?? "› human draft two\n  gpt-5.5 high"),
      sendCarriageReturn: vi.fn(),
      sendText: vi.fn(),
    };

    const idle = waitForVisiblePromptInputIdle({
      tmuxRuntimeManager,
      target,
      isTargetCurrent: () => true,
      stablePolls: 2,
      pollMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(idle).resolves.toMatchObject({ ok: true, reason: "idle", waitedMs: 3_000, changes: 1 });
    expect(tmuxRuntimeManager.captureTarget).toHaveBeenCalledTimes(4);
  });

  it("force-sends after the maximum buffer delay when prompt input keeps changing", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    let count = 0;
    const tmuxRuntimeManager = {
      captureTarget: vi.fn(() => `› human draft ${count++}\n  gpt-5.5 high`),
      sendCarriageReturn: vi.fn(),
      sendText: vi.fn(),
    };

    const idle = waitForVisiblePromptInputIdle({
      tmuxRuntimeManager,
      target,
      isTargetCurrent: () => true,
      stablePolls: 3,
      pollMs: 1_000,
      maxWaitMs: 2_000,
      onEvent: (event) => events.push(event.kind),
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(idle).resolves.toMatchObject({ ok: true, reason: "force", waitedMs: 2_000 });
    expect(events).toEqual(["start", "change", "change", "force"]);
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
