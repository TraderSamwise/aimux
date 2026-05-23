import { describe, expect, it } from "vitest";

import {
  messagesFromParsedAgentOutput,
  pendingPromptAlreadyRendered,
} from "@/lib/parsed-transcript";

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

  it("filters pending prompts already visible in the parsed transcript", () => {
    const rendered = messagesFromParsedAgentOutput({
      blocks: [{ type: "prompt", text: "hi" }],
    });

    expect(
      pendingPromptAlreadyRendered(
        {
          deliveryState: "submitted",
          parts: [{ type: "text", text: "hi" }],
        },
        rendered,
      ),
    ).toBe(true);
    expect(
      pendingPromptAlreadyRendered(
        {
          deliveryState: "failed",
          parts: [{ type: "text", text: "hi" }],
        },
        rendered,
      ),
    ).toBe(false);
  });
});
