import { describe, expect, it } from "vitest";
import { serializeAgentInput } from "./agent-message-parts.js";

describe("serializeAgentInput", () => {
  it("preserves ordered text and image parts", () => {
    const serialized = serializeAgentInput(
      {
        parts: [
          { type: "text", text: "Compare these layouts." },
          { type: "image", url: "https://example.com/a.png", alt: "first screenshot" },
          { type: "text", text: "The header spacing is off." },
          { type: "image", path: "/tmp/b.png" },
        ],
      },
      { tool: "claude" },
    );

    expect(serialized).toBe(
      [
        "Compare these layouts.",
        "[inline image for claude]\nsource: https://example.com/a.png\nalt: first screenshot",
        "The header spacing is off.",
        "[inline image for claude]\nsource: /tmp/b.png",
      ].join("\n\n"),
    );
  });

  it("falls back to data when no parts are provided", () => {
    expect(serializeAgentInput({ data: "hello" }, { tool: "codex" })).toBe("hello");
  });

  it("resolves attachment ids to local content paths when provided", () => {
    const serialized = serializeAgentInput(
      {
        parts: [{ type: "image", attachmentId: "att_123", alt: "picked screenshot" }],
      },
      {
        tool: "codex",
        resolveAttachmentPath: (attachmentId) => (attachmentId === "att_123" ? "/tmp/att_123.png" : null),
      },
    );

    expect(serialized).toBe("[inline image for codex]\nsource: /tmp/att_123.png\nalt: picked screenshot");
  });
});
