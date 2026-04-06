import { describe, expect, it } from "vitest";
import { deriveAlertFromAgentEvent } from "./plugin-runtime.js";

describe("deriveAlertFromAgentEvent", () => {
  it("maps direct-chat needs_input into a semantic alert", () => {
    const alert = deriveAlertFromAgentEvent("claude-1", {
      kind: "needs_input",
      message: "Ready for input",
      source: "claude",
      tone: "warn",
    });

    expect(alert).toMatchObject({
      kind: "needs_input",
      sessionId: "claude-1",
      title: "claude-1 needs input",
      message: "Ready for input",
      dedupeKey: "needs_input:claude-1",
    });
  });

  it("does not alert on plain response events", () => {
    expect(
      deriveAlertFromAgentEvent("claude-1", {
        kind: "response",
        message: "Here is the answer",
      }),
    ).toBeUndefined();
  });

  it("maps error notifications to task_failed alerts", () => {
    const alert = deriveAlertFromAgentEvent("claude-1", {
      kind: "notify",
      message: "Tool error",
      tone: "error",
    });

    expect(alert).toMatchObject({
      kind: "task_failed",
      title: "claude-1 failed",
      message: "Tool error",
    });
  });

  it("maps generic notifications to notification alerts", () => {
    const alert = deriveAlertFromAgentEvent("codex-1", {
      kind: "notify",
      message: "Build complete",
      tone: "info",
    });

    expect(alert).toMatchObject({
      kind: "notification",
      title: "codex-1",
      message: "Build complete",
    });
  });
});
