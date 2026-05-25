import { describe, expect, it } from "vitest";

import { messagesFromParsedAgentOutput } from "@/lib/parsed-transcript";

describe("parsed transcript conversion", () => {
  it("turns parsed prompt and response blocks into ordered chat messages", () => {
    const messages = messagesFromParsedAgentOutput({
      blocks: [
        { type: "meta", text: "Claude Code" },
        { type: "prompt", text: "hi" },
        { type: "response", text: "Hello there" },
        { type: "status", text: "ready" },
        { type: "prompt", text: "write me a poem" },
        { type: "response", text: "Roses compile\nTests are green" },
      ],
    });

    expect(messages).toEqual([
      {
        id: "parsed-1-prompt",
        role: "user",
        parts: [{ type: "text", text: "hi" }],
      },
      {
        id: "parsed-2-response",
        role: "assistant",
        parts: [{ type: "text", text: "Hello there" }],
      },
      {
        id: "parsed-4-prompt",
        role: "user",
        parts: [{ type: "text", text: "write me a poem" }],
      },
      {
        id: "parsed-5-response",
        role: "assistant",
        parts: [{ type: "text", text: "Roses compile\nTests are green" }],
      },
    ]);
  });

  it("accepts kind-based prompt and response blocks", () => {
    const messages = messagesFromParsedAgentOutput({
      blocks: [
        { kind: "prompt", text: "legacy hello" },
        { type: "response", text: "modern reply" },
        { kind: "response", text: "legacy reply" },
      ],
    });

    expect(messages).toEqual([
      {
        id: "parsed-0-prompt",
        role: "user",
        parts: [{ type: "text", text: "legacy hello" }],
      },
      {
        id: "parsed-1-response",
        role: "assistant",
        parts: [{ type: "text", text: "modern reply" }],
      },
      {
        id: "parsed-2-response",
        role: "assistant",
        parts: [{ type: "text", text: "legacy reply" }],
      },
    ]);
  });
});
