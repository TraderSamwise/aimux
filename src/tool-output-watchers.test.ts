import { describe, expect, it } from "vitest";
import { classifyToolPane, deriveObservation, extractLocalServices } from "./tool-output-watchers.js";

describe("classifyToolPane", () => {
  it("does not treat generic tool prompts as needs-input signals", () => {
    const classified = classifyToolPane("codex", ["Some output", "", "› Find and fix a bug in @filename"].join("\n"));
    expect(classified.promptVisible).toBe(false);
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

describe("deriveObservation", () => {
  it("initializes generic tools as running without prompt-based needs-input", () => {
    const { observation } = deriveObservation("codex-1", "codex", "OpenAI Codex\nstill working", undefined);

    expect(observation).toMatchObject({
      activity: "running",
      attention: "normal",
    });
    expect(observation?.event).toBeUndefined();
  });

  it("does not emit generic prompt-based completion or needs-input events", () => {
    const { observation } = deriveObservation("codex-1", "codex", ["output", "", "> "].join("\n"), {
      fingerprint: "prev",
      promptVisible: false,
      errorVisible: false,
      lastObservedAt: Date.now() - 1000,
      lastAppliedActivity: "running",
      lastAppliedAttention: "normal",
    });

    expect(observation).toBeUndefined();
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
    expect(observation?.activity).toBeUndefined();
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
});
