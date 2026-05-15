import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./agent-prompt-delivery.js", () => ({
  deliverTmuxPrompt: vi.fn(async () => true),
}));

import { deliverTmuxPrompt } from "./agent-prompt-delivery.js";
import { buildAimuxAgentInstructions, SessionBootstrapService } from "./session-bootstrap.js";

const deps: ConstructorParameters<typeof SessionBootstrapService>[0] = {
  tmuxRuntimeManager: {} as any,
  getSessionLabel: () => undefined,
  getSessionRole: () => undefined,
  getSessionWorktreePath: () => undefined,
  getSessionTmuxTarget: () => undefined,
};

describe("buildAimuxAgentInstructions", () => {
  it("explains aimux without requiring eager bookkeeping writes", () => {
    const instructions = buildAimuxAgentInstructions({ sessionId: "codex-123" });

    expect(instructions).toContain("agent multiplexer");
    expect(instructions).toContain("Claude, Codex, and shell sessions");
    expect(instructions).toContain("Your aimux session ID is codex-123");
    expect(instructions).toContain(".aimux/tasks/*.json");
    expect(instructions).toContain("Do not proactively create or edit `.aimux/plans/*` or `.aimux/status/*`");
    expect(instructions).not.toContain("Maintain a plan file");
    expect(instructions).not.toContain("Maintain a status file");
  });
});

describe("SessionBootstrapService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the shared aimux instructions in session preambles", () => {
    const service = new SessionBootstrapService(deps);
    const preamble = service.buildSessionPreamble({
      sessionId: "claude-123",
      command: "claude",
      includeAimuxPreamble: true,
    });

    expect(preamble).toContain("Your aimux session ID is claude-123");
    expect(preamble).toContain("Do not proactively create or edit `.aimux/plans/*` or `.aimux/status/*`");
    expect(preamble).not.toContain("Maintain a plan file");
  });

  it("attempts detached Codex kickoff delivery even if readiness probing times out", async () => {
    const target = { sessionName: "aimux-test", windowId: "@1", windowName: "codex" };
    const service = new SessionBootstrapService({
      tmuxRuntimeManager: {} as any,
      getSessionLabel: () => undefined,
      getSessionRole: () => undefined,
      getSessionWorktreePath: () => undefined,
      getSessionTmuxTarget: () => target,
    });

    vi.spyOn(service, "waitForDetachedCodexInputReady").mockResolvedValue(false);

    const kickoff = service.deliverDetachedCodexKickoffPrompt("codex-1", "follow the preamble", 0);
    await vi.advanceTimersByTimeAsync(1);
    await kickoff;

    expect(deliverTmuxPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        target,
        prompt: "follow the preamble",
        submit: true,
      }),
    );
  });
});
