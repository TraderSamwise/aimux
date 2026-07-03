import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { getProjectStateDirFor } from "./paths.js";
import { buildProjectHookCommand } from "./project-hook-command.js";

export interface ClaudeHookPayload {
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  hook_event_name?: string;
  message?: string;
  stop_reason?: string;
  object?: Record<string, unknown>;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

export function getAimuxCliEntryPath(): string {
  return fileURLToPath(new URL("./main.js", import.meta.url));
}

export function shouldSkipClaudeSessionIdInjection(args: string[]): boolean {
  return args.some(
    (arg) =>
      arg === "--resume" ||
      arg.startsWith("--resume=") ||
      arg === "--session-id" ||
      arg.startsWith("--session-id=") ||
      arg === "--continue" ||
      arg === "-c",
  );
}

function isUsableSessionIdArg(value: string | undefined): value is string {
  return Boolean(value?.trim() && !value.trim().startsWith("-"));
}

export function extractClaudeBackendSessionIdFromArgs(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--session-id" && isUsableSessionIdArg(args[i + 1])) {
      return args[i + 1].trim();
    }
    if (arg.startsWith("--session-id=")) {
      const value = arg.slice("--session-id=".length);
      if (isUsableSessionIdArg(value)) return value.trim();
    }
    if (arg === "--resume" && isUsableSessionIdArg(args[i + 1])) {
      return args[i + 1].trim();
    }
    if (arg.startsWith("--resume=")) {
      const value = arg.slice("--resume=".length);
      if (isUsableSessionIdArg(value)) return value.trim();
    }
  }
  return undefined;
}

function buildClaudeHookCommand(action: string, sessionId: string, projectRoot: string): string {
  return buildProjectHookCommand({
    tool: "claude",
    action,
    sessionIdFallback: sessionId,
    endpointFileFallback: join(getProjectStateDirFor(projectRoot), "metadata-api.txt"),
    timeoutSeconds: action === "permission-request" ? 120 : 5,
  });
}

export function buildClaudeHookSettings(opts: { sessionId: string; projectRoot: string }): string {
  const command = (action: string) => buildClaudeHookCommand(action, opts.sessionId, opts.projectRoot);
  return JSON.stringify({
    hooks: {
      SessionStart: [
        {
          matcher: "",
          hooks: [{ type: "command", command: command("session-start"), timeout: 10 }],
        },
      ],
      Stop: [
        {
          matcher: "",
          hooks: [{ type: "command", command: command("stop"), timeout: 10 }],
        },
      ],
      SessionEnd: [
        {
          matcher: "",
          hooks: [{ type: "command", command: command("session-end"), timeout: 1 }],
        },
      ],
      Notification: [
        {
          matcher: "",
          hooks: [{ type: "command", command: command("notification"), timeout: 10 }],
        },
      ],
      UserPromptSubmit: [
        {
          matcher: "",
          hooks: [{ type: "command", command: command("prompt-submit"), timeout: 10 }],
        },
      ],
      PreToolUse: [
        {
          matcher: "",
          hooks: [{ type: "command", command: command("pre-tool-use"), timeout: 5, async: true }],
        },
      ],
      PermissionRequest: [
        {
          matcher: "",
          hooks: [{ type: "command", command: command("permission-request"), timeout: 120 }],
        },
      ],
    },
  });
}

export function injectClaudeHookArgs(
  args: string[],
  opts: {
    sessionId: string;
    projectRoot: string;
    backendSessionId?: string;
  },
): string[] {
  const injected: string[] = ["--settings", buildClaudeHookSettings(opts), ...args];
  if (!opts.backendSessionId || shouldSkipClaudeSessionIdInjection(args)) {
    return injected;
  }
  return ["--session-id", opts.backendSessionId, ...injected];
}

export function parseClaudeHookPayload(raw: string): ClaudeHookPayload {
  try {
    return JSON.parse(raw) as ClaudeHookPayload;
  } catch {
    return {};
  }
}

function pickString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function summarizeClaudeNotification(payload: ClaudeHookPayload): { subtitle: string; body: string } {
  const object = payload.object ?? {};
  const subtitle = pickString(object.title, object["subtitle"], payload.hook_event_name) ?? "Needs input";
  const body =
    pickString(payload.message, object["message"], object["body"], object["question"]) ??
    "Claude needs your attention.";
  return { subtitle, body };
}

export function summarizeClaudeStop(payload: ClaudeHookPayload): { subtitle: string; body: string } {
  const object = payload.object ?? {};
  const subtitle = pickString(payload.stop_reason, object["stop_reason"]) ?? "Session complete";
  const body = pickString(payload.message, object["summary"], object["message"]) ?? "Claude completed its turn.";
  return { subtitle, body };
}

function summarizePermissionInput(toolName: string, input: Record<string, unknown> | undefined): string {
  const detail = input ? pickString(input["command"], input["file_path"], input["path"], input["url"]) : undefined;
  if (!detail) return toolName;
  const trimmed = detail.length > 200 ? `${detail.slice(0, 200)}…` : detail;
  return `${toolName}: ${trimmed}`;
}

export function summarizeClaudePermissionRequest(payload: ClaudeHookPayload): {
  toolName: string;
  input: Record<string, unknown> | undefined;
  summary: string;
} {
  const toolName = pickString(payload.tool_name) ?? "tool";
  const input = payload.tool_input;
  return { toolName, input, summary: summarizePermissionInput(toolName, input) };
}

/** Map a registry decision to the Claude PermissionRequest stdout JSON; `{}` defers to the native prompt. */
export function permissionRequestHookOutput(decision: string | undefined): Record<string, unknown> {
  const behavior = decision === "deny" ? "deny" : decision?.startsWith("allow") ? "allow" : undefined;
  if (!behavior) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior },
    },
  };
}
