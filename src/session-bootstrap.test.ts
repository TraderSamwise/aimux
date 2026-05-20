import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./agent-prompt-delivery.js", () => ({
  deliverTmuxPrompt: vi.fn(async () => true),
}));

import { deliverTmuxPrompt } from "./agent-prompt-delivery.js";
import { buildAimuxAgentInstructions, getToolResumeArgs, SessionBootstrapService } from "./session-bootstrap.js";

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
    expect(instructions).toContain("/agents/teammates?parentSessionId=codex-123");
    expect(instructions).toContain("/agents/teammates/create");
    expect(instructions).toContain("/agents/teammates/send");
    expect(instructions).toContain("Reuse existing teammates first");
    expect(instructions).toContain("aimux metadata endpoint");
    expect(instructions).not.toContain("Check `.aimux/sessions.json` for sessions with `team.parentSessionId`");
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

  it("does not tell teammate sessions to create nested teammates", () => {
    const service = new SessionBootstrapService(deps);
    const preamble = service.buildSessionPreamble({
      sessionId: "codex-child",
      command: "codex",
      includeAimuxPreamble: true,
      extraPreamble: 'You are a teammate for aimux parent agent "codex-parent".',
      team: {
        teamId: "team-codex-parent",
        parentSessionId: "codex-parent",
        role: "coder",
      },
    });

    expect(preamble).toContain('You are a teammate for aimux parent agent "codex-parent".');
    expect(preamble).not.toContain("/agents/teammates/create");
    expect(preamble).not.toContain("Reuse existing teammates first");
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

  it("requires an explicit session placeholder for backend-id resume", () => {
    const bootstrap = new SessionBootstrapService(deps);

    expect(bootstrap.canResumeWithBackendSessionId({ resumeArgs: ["--resume", "{sessionId}"] }, "backend-1")).toBe(
      true,
    );
    expect(bootstrap.canResumeWithBackendSessionId({ resumeArgs: ["--continue"] }, "backend-1")).toBe(false);
  });
});

describe("getToolResumeArgs", () => {
  it("does not build non-specific resume args for targeted restore", () => {
    expect(getToolResumeArgs({ resumeArgs: ["--resume", "{sessionId}"] } as any, "backend-1")).toEqual([
      "--resume",
      "backend-1",
    ]);
    expect(getToolResumeArgs({ resumeArgs: ["--continue"] } as any, "backend-1")).toBeUndefined();
  });
});
