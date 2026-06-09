import { describe, expect, it } from "vitest";
import {
  buildClaudeHookSettings,
  extractClaudeBackendSessionIdFromArgs,
  injectClaudeHookArgs,
  permissionRequestHookOutput,
  shouldSkipClaudeSessionIdInjection,
  summarizeClaudePermissionRequest,
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
      "PermissionRequest",
      "PreToolUse",
      "SessionEnd",
      "SessionStart",
      "Stop",
      "UserPromptSubmit",
    ]);
    expect(settings.hooks.PreToolUse[0].hooks[0].async).toBe(true);
    expect(settings.hooks.SessionEnd[0].hooks[0].timeout).toBeLessThanOrEqual(1);
    expect(settings.hooks.PermissionRequest[0].hooks[0].timeout).toBe(120);
    expect(settings.hooks.PermissionRequest[0].hooks[0].command).toContain("permission-request");
  });

  it("maps registry decisions to PermissionRequest hook output", () => {
    expect(permissionRequestHookOutput("allow_once")).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
    });
    expect(permissionRequestHookOutput("allow_always")).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
    });
    expect(permissionRequestHookOutput("deny")).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny" } },
    });
    expect(permissionRequestHookOutput(undefined)).toEqual({});
    expect(permissionRequestHookOutput("weird")).toEqual({});
  });

  it("summarizes a permission request payload", () => {
    expect(
      summarizeClaudePermissionRequest({ tool_name: "Bash", tool_input: { command: "rm -rf build" } }),
    ).toEqual({ toolName: "Bash", input: { command: "rm -rf build" }, summary: "Bash: rm -rf build" });
    expect(summarizeClaudePermissionRequest({ tool_name: "Read", tool_input: { file_path: "/a/b.ts" } }).summary).toBe(
      "Read: /a/b.ts",
    );
    expect(summarizeClaudePermissionRequest({}).summary).toBe("tool");
  });

  it("truncates an overlong permission detail", () => {
    const long = "x".repeat(500);
    const { summary } = summarizeClaudePermissionRequest({ tool_name: "Bash", tool_input: { command: long } });
    expect(summary.length).toBeLessThan(260);
    expect(summary.endsWith("…")).toBe(true);
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
