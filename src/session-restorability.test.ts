import { describe, expect, it } from "vitest";
import { describeSessionRestorability } from "./session-restorability.js";

describe("describeSessionRestorability", () => {
  it("prefers toolConfigKey when checking exact backend resume support", () => {
    expect(
      describeSessionRestorability(
        {
          id: "claude-custom-1",
          status: "offline",
          tool: "claude",
          command: "claude",
          toolConfigKey: "claude-custom",
          backendSessionId: "backend-1",
        },
        {
          claude: { resumeArgs: [], resumeByBackendSessionId: false },
          "claude-custom": { resumeArgs: ["--resume", "{sessionId}"], resumeByBackendSessionId: true },
        },
      ),
    ).toEqual({ restoreState: "ready" });
  });

  it("reports custom tool config restore blockers by config key", () => {
    expect(
      describeSessionRestorability(
        {
          id: "claude-custom-1",
          status: "offline",
          tool: "claude",
          command: "claude",
          toolConfigKey: "claude-custom",
          backendSessionId: "backend-1",
        },
        {
          claude: { resumeArgs: ["--resume", "{sessionId}"], resumeByBackendSessionId: true },
          "claude-custom": { resumeArgs: [], resumeByBackendSessionId: false },
        },
      ),
    ).toEqual({
      restoreState: "blocked",
      restoreBlockedReason: 'agent tool "claude-custom" does not support exact backend resume',
    });
  });

  it("revalidates precomputed ready state against exact backend resume requirements", () => {
    expect(
      describeSessionRestorability(
        {
          id: "claude-stale-ready",
          status: "offline",
          command: "claude",
          toolConfigKey: "claude",
          restoreState: "ready",
        },
        {
          claude: { resumeArgs: ["--resume", "{sessionId}"], resumeByBackendSessionId: true },
        },
      ),
    ).toEqual({
      restoreState: "blocked",
      restoreBlockedReason: "missing exact resumable backend session id",
    });
  });

  it("allows backend-less offline sessions that are safe to relaunch fresh", () => {
    expect(
      describeSessionRestorability(
        {
          id: "codex-empty",
          status: "offline",
          command: "codex",
          toolConfigKey: "codex",
          freshRelaunchAllowed: true,
        },
        {
          codex: { resumeArgs: ["resume", "{sessionId}"], resumeByBackendSessionId: true },
        },
      ),
    ).toEqual({ restoreState: "ready" });
  });

  it("keeps persisted restore blockers ahead of backend ids", () => {
    expect(
      describeSessionRestorability(
        {
          id: "claude-crashed",
          status: "offline",
          command: "claude",
          toolConfigKey: "claude",
          backendSessionId: "backend-1",
          restoreBlockedReason: "agent exited during startup",
        },
        {
          claude: { resumeArgs: ["--resume", "{sessionId}"], resumeByBackendSessionId: true },
        },
      ),
    ).toEqual({
      restoreState: "blocked",
      restoreBlockedReason: "agent exited during startup",
    });
  });
});
