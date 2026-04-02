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
});
