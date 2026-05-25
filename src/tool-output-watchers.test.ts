import { describe, expect, it } from "vitest";
import { classifyToolPane } from "./tool-output-watchers.js";

describe("classifyToolPane", () => {
  it("detects Codex prompt panes as needs-input signals", () => {
    const classified = classifyToolPane("codex", ["Some output", "", "› Find and fix a bug in @filename"].join("\n"));
    expect(classified.promptVisible).toBe(true);
    expect(classified.errorVisible).toBe(false);
  });

  it("detects Claude prompt panes", () => {
    const classified = classifyToolPane(
      "claude",
      ["sam@MacBook-Pro-4 ~/repo main", "bypass permissions on (shift+tab to cycle)", "❯ "].join("\n"),
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

  it("detects Codex update prompts", () => {
    const classified = classifyToolPane(
      "codex",
      [
        "Update available! 0.121.0 -> 0.122.0",
        "Run npm install -g @openai/codex to update.",
        "See full release notes:",
      ].join("\n"),
    );

    expect(classified.updatePromptVisible).toBe(true);
    expect(classified.blockedMessage).toContain("npm install -g @openai/codex");
    expect(classified.promptVisible).toBe(false);
  });

  it("detects Claude update prompts", () => {
    const classified = classifyToolPane(
      "claude",
      ["Claude Code v2.1.116", "Update available.", "Run `claude update` to install."].join("\n"),
    );

    expect(classified.updatePromptVisible).toBe(true);
    expect(classified.blockedMessage).toContain("claude update");
    expect(classified.promptVisible).toBe(false);
  });

  it("does not keep stale error state once later output exists", () => {
    const classified = classifyToolPane(
      "codex",
      [
        "Conversation interrupted - tell the model what to do differently.",
        "Something went wrong.",
        "> continue",
        "Working (12s - esc to interrupt)",
      ].join("\n"),
    );

    expect(classified.errorVisible).toBe(false);
    expect(classified.interruptedVisible).toBe(false);
  });
});
