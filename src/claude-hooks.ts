import { fileURLToPath } from "node:url";

export interface ClaudeHookPayload {
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  hook_event_name?: string;
  message?: string;
  stop_reason?: string;
  object?: Record<string, unknown>;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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

function buildClaudeHookCommand(action: string, sessionId: string, projectRoot: string): string {
  return [
    shellQuote(process.execPath),
    shellQuote(getAimuxCliEntryPath()),
    "claude-hook",
    action,
    "--session",
    shellQuote(sessionId),
    "--project",
    shellQuote(projectRoot),
  ].join(" ");
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
