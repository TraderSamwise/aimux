import { describe, expect, it } from "vitest";

import { summarizeInteractionForDisplay } from "./interaction-display.js";

describe("summarizeInteractionForDisplay", () => {
  it("formats question payloads with option labels", () => {
    const display = summarizeInteractionForDisplay({
      sessionId: "codex-one",
      type: "question",
      payload: {
        questions: [
          {
            question: "Which branch?",
            options: [{ label: "master" }, "current HEAD"],
          },
          {
            question: "Run tests?",
            options: [{ label: "yes" }, { label: "no" }],
          },
        ],
      },
    });

    expect(display).toEqual({
      title: "AskUserQuestion",
      message: "1. Which branch?\nOptions: master; current HEAD\n\n2. Run tests?\nOptions: yes; no",
      summary: "Which branch?; Run tests?",
    });
  });

  it("does not show raw JSON summaries as user-facing text", () => {
    const display = summarizeInteractionForDisplay({
      sessionId: "claude-one",
      type: "permission",
      payload: {},
      summary: JSON.stringify({ toolName: "Bash" }),
    });

    expect(display).toEqual({
      title: "claude-one needs a response",
      message: "Agent is waiting on a permission response.",
      summary: undefined,
    });
  });
});
