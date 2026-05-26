import { describe, expect, it } from "vitest";
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
    expect(instructions).toContain("runtime exchange");
    expect(instructions).toContain("Do not directly spawn or control other agents");
    expect(instructions).toContain("Do not call aimux metadata APIs from inside an agent");
    expect(instructions).toContain("For generic delegation or handoff records");
    expect(instructions).toContain("Treat tasks as shared handoff records");
    expect(instructions).not.toContain("dispatches pending tasks");
    expect(instructions).not.toContain("[AIMUX TASK");
    expect(instructions).not.toContain("aimux metadata endpoint");
    expect(instructions).not.toContain("/agents/teammates");
    expect(instructions).not.toContain("Teammates API");
    expect(instructions).not.toContain("Team lifecycle uses the local metadata teammate API");
    expect(instructions).not.toContain("initialPrompt");
    expect(instructions).not.toContain("sessions.json");
    expect(instructions).toContain("Do not proactively create or edit `.aimux/plans/*` or `.aimux/status/*`");
    expect(instructions).not.toContain("Maintain a plan file");
    expect(instructions).not.toContain("Maintain a status file");
  });
});

describe("SessionBootstrapService", () => {
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
    expect(preamble).toContain("This session is already a teammate; do not create nested teammate teams.");
    expect(preamble).not.toContain("/agents/teammates/create");
    expect(preamble).not.toContain("Reuse existing teammates first");
    expect(preamble).not.toContain("Team lifecycle uses the local metadata teammate API");
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
