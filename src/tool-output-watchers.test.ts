import { describe, expect, it } from "vitest";
import { classifyToolPane, extractLocalServices } from "./tool-output-watchers.js";

describe("classifyToolPane", () => {
  it("detects prompt-visible panes", () => {
    const classified = classifyToolPane("codex", ["Some output", "", "› Find and fix a bug in @filename"].join("\n"));
    expect(classified.promptVisible).toBe(true);
    expect(classified.errorVisible).toBe(false);
  });

  it("detects Claude prompt panes", () => {
    const classified = classifyToolPane(
      "claude",
      ["sam@MacBook-Pro-4 ~/repo main", "▶▶ bypass permissions on (shift+tab to cycle)", "❯ "].join("\n"),
    );
    expect(classified.promptVisible).toBe(true);
    expect(classified.errorVisible).toBe(false);
  });

  it("detects interrupted/error panes", () => {
    const classified = classifyToolPane(
      "codex",
      ["Conversation interrupted - tell the model what to do differently.", "Something went wrong."].join("\n"),
    );
    expect(classified.errorVisible).toBe(true);
    expect(classified.interruptedVisible).toBe(true);
  });

  it("extracts localhost services from pane output", () => {
    expect(
      extractLocalServices(
        [
          "App started on http://localhost:3000",
          "API on http://127.0.0.1:8787/health",
          "Ignore https://example.com",
        ].join("\n"),
      ),
    ).toEqual([
      { url: "http://localhost:3000", port: 3000 },
      { url: "http://127.0.0.1:8787/health", port: 8787 },
    ]);
  });
});
