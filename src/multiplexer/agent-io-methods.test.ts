import { describe, expect, it, vi } from "vitest";

import { agentIoMethods } from "./agent-io-methods.js";

describe("agentIoMethods orchestration delivery", () => {
  it("uses submitted agent input for direct message delivery", () => {
    const session = {
      id: "codex-1",
      exited: false,
      status: "running",
      write: vi.fn(),
    };
    const writeAgentInput = vi.fn();
    const host: any = {
      sessions: [session],
      deriveSessionSemanticState: () => ({ runtime: { canReceiveInput: true, isAlive: true } }),
      composeOrchestrationPrompt: agentIoMethods.composeOrchestrationPrompt,
      writeAgentInput,
    };

    const delivered = agentIoMethods.deliverOrchestrationMessage.call(
      host,
      ["codex-1"],
      "thread-1",
      "claude-1",
      "Review is done.",
      "status",
      "review complete",
    );

    expect(delivered).toEqual(["codex-1"]);
    expect(session.write).not.toHaveBeenCalled();
    expect(writeAgentInput).toHaveBeenCalledWith(
      "codex-1",
      expect.stringContaining("Check the thread now"),
      undefined,
      undefined,
      true,
    );
  });

  it("formats pushed messages as active instructions, not passive context", () => {
    const prompt = agentIoMethods.composeOrchestrationPrompt("thread-1", "claude-1", "Ping.", "status", "review done");

    expect(prompt).toContain("[AIMUX MESSAGE thread-1 from claude-1]");
    expect(prompt).toContain("This is a status message delivered by aimux.");
    expect(prompt).toContain("Check the thread now");
    expect(prompt).toContain("acknowledge that no action is needed");
  });
});
