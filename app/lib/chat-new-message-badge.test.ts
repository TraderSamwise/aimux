import { describe, expect, it } from "vitest";

import { chatFrozenNewMessageCount, type ChatMessageIdentity } from "./chat-new-message-badge";

function message(id: string, role = "assistant"): ChatMessageIdentity {
  return { id, role };
}

describe("chat new message badge", () => {
  it("does not count when the live transcript has not appended messages", () => {
    expect(
      chatFrozenNewMessageCount({
        frozenMessages: [message("assistant:1"), message("assistant:2")],
        liveMessages: [message("assistant:1"), message("assistant:2")],
      }),
    ).toBe(0);
  });

  it("counts appended tail messages while a transcript is frozen", () => {
    expect(
      chatFrozenNewMessageCount({
        frozenMessages: [message("assistant:1")],
        liveMessages: [message("assistant:1"), message("assistant:2"), message("assistant:3")],
      }),
    ).toBe(2);
  });

  it("ignores parser churn that rewrites older message identity", () => {
    expect(
      chatFrozenNewMessageCount({
        frozenMessages: [message("assistant:old")],
        liveMessages: [message("assistant:rewritten"), message("assistant:new")],
      }),
    ).toBe(0);
  });

  it("counts append after the frozen newest in-progress message gets a stable id", () => {
    expect(
      chatFrozenNewMessageCount({
        frozenMessages: [message("codex-1:latest")],
        liveMessages: [message("assistant:stable"), message("assistant:new")],
      }),
    ).toBe(1);
  });

  it("does not treat an older latest marker mismatch as a safe append", () => {
    expect(
      chatFrozenNewMessageCount({
        frozenMessages: [message("assistant:older"), message("codex-1:latest")],
        liveMessages: [
          message("assistant:rewritten"),
          message("assistant:stable"),
          message("assistant:new"),
        ],
      }),
    ).toBe(0);
  });

  it("falls back to client message ids before positional identity", () => {
    expect(
      chatFrozenNewMessageCount({
        frozenMessages: [{ clientMessageId: "composer:1", role: "user" }],
        liveMessages: [
          { clientMessageId: "composer:1", role: "user" },
          { clientMessageId: "composer:2", role: "user" },
        ],
      }),
    ).toBe(1);
  });
});
