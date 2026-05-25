import { describe, expect, it, vi } from "vitest";

import { agentIoMethods } from "./agent-io-methods.js";

describe("agentIoMethods orchestration delivery", () => {
  it("does not deliver direct messages through the old agent input path", () => {
    const session = {
      id: "codex-1",
      exited: false,
      status: "running",
      write: vi.fn(),
    };
    const legacyInputPath = vi.fn();
    const host: any = {
      sessions: [session],
      deriveSessionSemanticState: () => ({ runtime: { canReceiveInput: true, isAlive: true } }),
      legacyInputPath,
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

    expect(delivered).toEqual([]);
    expect(session.write).not.toHaveBeenCalled();
    expect(legacyInputPath).not.toHaveBeenCalled();
  });
});
