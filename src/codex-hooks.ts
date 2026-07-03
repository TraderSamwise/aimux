import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { buildProjectHookCommand } from "./project-hook-command.js";

export interface CodexHookPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  message?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

interface CodexHookEntry {
  type?: string;
  command?: string;
  timeout?: number;
  [key: string]: unknown;
}
interface CodexHookGroup {
  hooks?: CodexHookEntry[];
  [key: string]: unknown;
}
export interface CodexHooksFile {
  hooks?: Record<string, CodexHookGroup[]>;
  [key: string]: unknown;
}

const CODEX_HOOK_EVENTS: ReadonlyArray<{ event: string; action: string; timeoutMs: number }> = [
  { event: "SessionStart", action: "session-start", timeoutMs: 5000 },
  { event: "UserPromptSubmit", action: "prompt-submit", timeoutMs: 5000 },
  { event: "Stop", action: "stop", timeoutMs: 5000 },
  { event: "PermissionRequest", action: "permission-request", timeoutMs: 5000 },
];

const AIMUX_CODEX_HOOK_MARKERS = ["/hooks/codex", "codex-hook"];

export function getCodexHome(codexHome?: string): string {
  return codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

export function codexHooksPath(codexHome?: string): string {
  return join(getCodexHome(codexHome), "hooks.json");
}

/** Env-gated hook command: the global hooks.json is shared, so per-session
 * identity comes from AIMUX_SESSION_ID at runtime; the guard no-ops for
 * non-aimux Codex sessions. */
export function buildCodexHookCommand(action: string): string {
  return buildProjectHookCommand({
    tool: "codex",
    action,
    timeoutSeconds: 5,
  });
}

export function isAimuxOwnedCodexHookCommand(command: unknown): boolean {
  return typeof command === "string" && AIMUX_CODEX_HOOK_MARKERS.some((marker) => command.includes(marker));
}

/** Per-launch flags that enable + trust hooks without any config.toml mutation.
 * The trust bypass applies to the per-user hooks.json aimux owns and writes. */
export function codexLaunchHookArgs(): string[] {
  return ["-c", "features.hooks=true", "--dangerously-bypass-hook-trust"];
}

/** Merge aimux's hook groups into an existing hooks file, preserving all foreign entries. */
export function mergeCodexHooks(existing: CodexHooksFile): CodexHooksFile {
  const hooks: Record<string, CodexHookGroup[]> = { ...(existing.hooks ?? {}) };
  for (const { event, action, timeoutMs } of CODEX_HOOK_EVENTS) {
    const preserved = (hooks[event] ?? [])
      .map((group) => ({
        ...group,
        hooks: (group.hooks ?? []).filter((entry) => !isAimuxOwnedCodexHookCommand(entry.command)),
      }))
      .filter((group) => (group.hooks?.length ?? 0) > 0);
    preserved.push({ hooks: [{ type: "command", command: buildCodexHookCommand(action), timeout: timeoutMs }] });
    hooks[event] = preserved;
  }
  return { ...existing, hooks };
}

export function installCodexHooks(options: { codexHome?: string } = {}): { path: string; changed: boolean } {
  const path = codexHooksPath(options.codexHome);
  let existing: CodexHooksFile = {};
  const prev = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (prev) {
    try {
      existing = JSON.parse(prev) as CodexHooksFile;
    } catch {
      throw new Error(`Codex hooks file exists but is not valid JSON: ${path}`);
    }
  }
  const next = `${JSON.stringify(mergeCodexHooks(existing), null, 2)}\n`;
  if (next === prev) return { path, changed: false };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
  return { path, changed: true };
}

export function parseCodexHookPayload(raw: string): CodexHookPayload {
  try {
    return JSON.parse(raw) as CodexHookPayload;
  } catch {
    return {};
  }
}
