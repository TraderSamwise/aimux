import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { InitialAgentOutputFeedStatus } from "@/lib/agent-output-feed-state";
import {
  agentPanePlaceholderState,
  chatTranscriptPlaceholderState,
  terminalOutputPlaceholderState,
} from "@/lib/chat-loading";

/**
 * The two panes describe one connection the same way.
 *
 * They render the same session's data from the same feed, side by side. When
 * each classified it for itself they agreed only by luck, and they did not:
 * with the relay failing every request, the chat pane said "Transcript
 * unavailable -- Daemon connection replaced" and offered Retry while the
 * terminal pane spun "Loading output" for ever. One dead connection, two
 * situations, and only one of them looked like something had gone wrong.
 *
 * Compared against each other rather than one test per pane, because a
 * per-pane test passes happily while the panes disagree.
 */
const STATUSES: InitialAgentOutputFeedStatus[] = ["idle", "loading", "timed-out"];
const ERRORS = [null, "Daemon connection replaced", "Relay not connected", "Internal error"];

describe("the chat pane and the terminal pane agree", () => {
  it("reaches the same kind for every state the feed can be in", () => {
    for (const initialStatus of STATUSES) {
      for (const lastError of ERRORS) {
        const chat = chatTranscriptPlaceholderState({ initialStatus, lastError, messageCount: 0 });
        const terminal = terminalOutputPlaceholderState({
          initialStatus,
          lastError,
          hasOutput: false,
        });
        expect(terminal.kind, `${initialStatus} / ${lastError}`).toBe(chat.kind);
        if (chat.kind !== "none" && terminal.kind !== "none") {
          // The words differ per surface on purpose; the message is the
          // failure itself and must be the same sentence.
          expect(terminal.title).not.toBe("");
          if (chat.kind === "error") expect(terminal.message).toBe(chat.message);
        }
      }
    }
  });

  it("says nothing in either pane once there is something to show", () => {
    for (const initialStatus of STATUSES) {
      expect(
        agentPanePlaceholderState("chat", { initialStatus, lastError: "x", hasContent: true }).kind,
      ).toBe("none");
      expect(
        agentPanePlaceholderState("terminal", { initialStatus, lastError: "x", hasContent: true })
          .kind,
      ).toBe("none");
    }
  });

  it("surfaces an error in the terminal pane instead of spinning", () => {
    const terminal = terminalOutputPlaceholderState({
      initialStatus: "idle",
      lastError: "Daemon connection replaced",
      hasOutput: false,
    });
    expect(terminal.kind).toBe("error");
    if (terminal.kind !== "error") throw new Error("narrowing");
    expect(terminal.message).toBe("Daemon connection replaced");
  });

  it("is what the terminal pane actually renders, not just what the helper returns", () => {
    // The helper agreeing is worth nothing if the pane ignores it, which is
    // precisely what the hardcoded spinner did.
    const source = readFileSync(
      join(__dirname, "..", "components", "screens", "AgentChatScreen.tsx"),
      "utf8",
    );
    expect(source).toContain("terminalOutputPlaceholderState({");
    expect(source).toContain("{terminalPlaceholder.title}");
    expect(source).toContain("{terminalPlaceholder.message}");
    // And reachable: the only thing allowed to blank it is the shared state
    // saying there is nothing to say. A source assertion is a weak proof of a
    // render, but it is the proof available without mounting the screen, and
    // it is what catches the guard being short-circuited.
    expect(source).toContain('{terminalPlaceholder.kind === "none" ? null : (');
    // The sentence that used to be unconditional is gone from the component.
    expect(source).not.toContain("Waiting for terminal output from the project service.");
  });
});
