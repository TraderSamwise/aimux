import { describe, expect, it } from "vitest";
import {
  buildClaudeHookSettings,
  extractClaudeBackendSessionIdFromArgs,
  injectClaudeHookArgs,
  shouldSkipClaudeSessionIdInjection,
} from "./claude-hooks.js";

describe("claude-hooks", () => {
  it("builds the supported cmux-style hook set", () => {
    const settings = JSON.parse(
      buildClaudeHookSettings({
        sessionId: "claude-abc123",
        projectRoot: "/tmp/project",
      }),
    );
    expect(Object.keys(settings.hooks).sort()).toEqual([
      "Notification",
      "PreToolUse",
      "SessionEnd",
      "SessionStart",
      "Stop",
      "UserPromptSubmit",
    ]);
    expect(settings.hooks.PreToolUse[0].hooks[0].async).toBe(true);
    expect(settings.hooks.SessionEnd[0].hooks[0].timeout).toBeLessThanOrEqual(1);
  });

  it("injects settings and backend session id when allowed", () => {
    const args = injectClaudeHookArgs(["hello"], {
      sessionId: "claude-abc123",
      projectRoot: "/tmp/project",
      backendSessionId: "backend-123",
    });
    expect(args[0]).toBe("--session-id");
    expect(args[1]).toBe("backend-123");
    expect(args).toContain("--settings");
  });

  it("skips backend session id injection for resume-style args", () => {
    expect(shouldSkipClaudeSessionIdInjection(["--resume"])).toBe(true);
    expect(shouldSkipClaudeSessionIdInjection(["--continue"])).toBe(true);
    expect(shouldSkipClaudeSessionIdInjection(["hello"])).toBe(false);
  });

  it("extracts explicit backend ids from Claude resume args", () => {
    expect(extractClaudeBackendSessionIdFromArgs(["--resume", "backend-123"])).toBe("backend-123");
    expect(extractClaudeBackendSessionIdFromArgs(["--resume=backend-456"])).toBe("backend-456");
    expect(extractClaudeBackendSessionIdFromArgs(["--session-id", "backend-789"])).toBe("backend-789");
    expect(extractClaudeBackendSessionIdFromArgs(["--resume", "--dangerously-skip-permissions"])).toBeUndefined();
    expect(extractClaudeBackendSessionIdFromArgs(["--resume"])).toBeUndefined();
  });
});
