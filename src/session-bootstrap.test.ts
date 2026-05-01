import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./agent-prompt-delivery.js", () => ({
  deliverTmuxPrompt: vi.fn(async () => true),
}));

import { deliverTmuxPrompt } from "./agent-prompt-delivery.js";
import { SessionBootstrapService } from "./session-bootstrap.js";

describe("SessionBootstrapService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
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
