import { describe, expect, it } from "vitest";
import { classifyToolPane, deriveObservation, extractLocalServices } from "./tool-output-watchers.js";

describe("classifyToolPane", () => {
  it("detects Codex prompt panes as needs-input signals", () => {
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

  it("detects Codex update prompts", () => {
    const classified = classifyToolPane(
      "codex",
      [
        "✨ Update available! 0.121.0 -> 0.122.0",
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

describe("deriveObservation", () => {
  it("initializes generic tools as running without prompt-based needs-input", () => {
    const { observation } = deriveObservation("codex-1", "codex", "OpenAI Codex\nstill working", undefined);

    expect(observation).toMatchObject({
      activity: "running",
      attention: "normal",
    });
    expect(observation?.event).toBeUndefined();
  });

  it("does not treat plain shell chevrons as Codex needs-input prompts", () => {
    const { observation } = deriveObservation("codex-1", "codex", ["output", "", "> "].join("\n"), {
      fingerprint: "prev",
      promptVisible: false,
      errorVisible: false,
      lastObservedAt: Date.now() - 1000,
      lastAppliedActivity: "running",
      lastAppliedAttention: "normal",
    });

    expect(observation).toMatchObject({
      activity: "running",
      attention: "normal",
    });
    expect(observation?.event).toBeUndefined();
  });

  it("emits Codex prompt-based needs-input events for Codex prompt glyphs", () => {
    const { observation } = deriveObservation(
      "codex-1",
      "codex",
      ["output", "", "› Explain this codebase"].join("\n"),
      {
        fingerprint: "prev",
        promptVisible: false,
        errorVisible: false,
        lastObservedAt: Date.now() - 1000,
        lastAppliedActivity: "running",
        lastAppliedAttention: "normal",
      },
    );

    expect(observation).toMatchObject({
      activity: "waiting",
      attention: "needs_input",
      event: {
        kind: "needs_input",
        message: "Ready for input",
        source: "codex",
        tone: "warn",
      },
    });
  });

  it("clears Codex needs-input attention when the prompt disappears", () => {
    const { observation } = deriveObservation("codex-1", "codex", "Working (1s · esc to interrupt)", {
      fingerprint: "prev",
      promptVisible: true,
      errorVisible: false,
      lastObservedAt: Date.now() - 1000,
      lastAppliedActivity: "waiting",
      lastAppliedAttention: "needs_input",
    });

    expect(observation).toMatchObject({
      activity: "running",
      attention: "normal",
    });
  });

  it("clears stale generic error attention when pane recovers", () => {
    const { observation } = deriveObservation("codex-1", "codex", "continuing work normally", {
      fingerprint: "prev",
      promptVisible: false,
      errorVisible: true,
      lastObservedAt: Date.now() - 1000,
      lastAppliedActivity: "error",
      lastAppliedAttention: "error",
    });

    expect(observation).toMatchObject({
      attention: "normal",
    });
    expect(observation?.activity).toBe("running");
  });

  it("keeps Claude on the explicit needs_input path", () => {
    const { observation } = deriveObservation("claude-1", "claude", ["output", "", "❯ "].join("\n"), {
      fingerprint: "prev",
      promptVisible: false,
      errorVisible: false,
      lastObservedAt: Date.now() - 1000,
      lastAppliedActivity: "running",
      lastAppliedAttention: "normal",
    });

    expect(observation?.event).toMatchObject({
      kind: "needs_input",
      message: "Ready for input",
      source: "claude",
      tone: "warn",
    });
  });

  it("blocks Codex on update prompt with explicit instructions", () => {
    const { observation } = deriveObservation(
      "codex-1",
      "codex",
      ["✨ Update available! 0.121.0 -> 0.122.0", "Run npm install -g @openai/codex to update."].join("\n"),
      undefined,
    );

    expect(observation).toMatchObject({
      activity: "waiting",
      attention: "blocked",
      event: {
        kind: "blocked",
        source: "codex",
        tone: "warn",
      },
    });
    expect(observation?.event?.message).toContain("npm install -g @openai/codex");
  });

  it("blocks Claude on update prompt with explicit instructions", () => {
    const { observation } = deriveObservation(
      "claude-1",
      "claude",
      ["Claude Code v2.1.116", "Update available.", "Run `claude update` to install."].join("\n"),
      undefined,
    );

    expect(observation).toMatchObject({
      activity: "waiting",
      attention: "blocked",
      event: {
        kind: "blocked",
        source: "claude",
        tone: "warn",
      },
    });
    expect(observation?.event?.message).toContain("claude update");
  });

  it("recovers from blocked update prompt back to running for Codex", () => {
    const { observation } = deriveObservation("codex-1", "codex", "OpenAI Codex\nstill working", {
      fingerprint: "prev",
      promptVisible: false,
      errorVisible: false,
      lastObservedAt: Date.now() - 1000,
      lastAppliedActivity: "waiting",
      lastAppliedAttention: "blocked",
    });

    expect(observation).toMatchObject({
      activity: "running",
      attention: "normal",
    });
  });
});
