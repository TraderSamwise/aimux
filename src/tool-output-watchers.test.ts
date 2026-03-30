import { describe, expect, it } from "vitest";
import { classifyToolPane } from "./tool-output-watchers.js";

describe("classifyToolPane", () => {
  it("detects prompt-visible panes", () => {
    const classified = classifyToolPane("codex", ["Some output", "", "› Find and fix a bug in @filename"].join("\n"));
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
});
