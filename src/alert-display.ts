import { basename } from "node:path";
import type { SessionMetadata } from "./metadata-store.js";
import type { AlertEvent, AlertKind } from "./project-events.js";

export interface SessionAlertDisplayContext {
  label?: string;
  command?: string;
  worktreePath?: string;
  worktreeName?: string;
  branch?: string;
}

export type AlertPublishInput = Omit<AlertEvent, "type" | "projectId" | "ts"> & {
  dedupeKey?: string;
  cooldownMs?: number;
  forceNotify?: boolean;
};

export function compactSessionId(sessionId: string): string {
  const compact = sessionId.replace(/-[a-z0-9]{4,}$/i, "");
  return compact || sessionId;
}

export function metadataDisplayContext(metadata?: SessionMetadata): SessionAlertDisplayContext {
  return {
    label: metadata?.label,
    worktreePath: metadata?.context?.worktreePath,
    worktreeName: metadata?.context?.worktreeName,
    branch: metadata?.context?.branch,
  };
}

export function mergeDisplayContext(
  base: SessionAlertDisplayContext,
  override: SessionAlertDisplayContext,
): SessionAlertDisplayContext {
  return {
    label: override.label ?? base.label,
    command: override.command ?? base.command,
    worktreePath: override.worktreePath ?? base.worktreePath,
    worktreeName: override.worktreeName ?? base.worktreeName,
    branch: override.branch ?? base.branch,
  };
}

export function displayWorktreeLabel(context: SessionAlertDisplayContext): string | undefined {
  const worktreeName = context.worktreeName?.trim();
  const branch = context.branch?.trim();
  if (worktreeName) return worktreeName;
  if (branch) return branch;
  const path = context.worktreePath?.trim();
  return path ? basename(path) : undefined;
}

export function sessionAlertSubject(
  sessionId: string | undefined,
  context: SessionAlertDisplayContext | undefined,
): string | undefined {
  if (!sessionId) return undefined;
  const label = context?.label?.trim() || context?.command?.trim() || compactSessionId(sessionId);
  const worktree = context ? displayWorktreeLabel(context) : undefined;
  return worktree ? `${label} @ ${worktree}` : label;
}

export function sessionAlertTitle(
  kind: AlertKind,
  sessionId: string | undefined,
  fallback: string | undefined,
  context?: SessionAlertDisplayContext,
): string {
  const title = fallback?.trim();
  const subject = sessionAlertSubject(sessionId, context);
  if (!subject) return title || "aimux";
  if (kind === "needs_input") return `${subject} needs input`;
  if (kind === "blocked") {
    if (!title || (sessionId && title === `${sessionId} is blocked`)) return `${subject} is blocked`;
    return title;
  }
  if (kind === "task_failed") {
    if (!title || (sessionId && (title === `${sessionId} errored` || title === `${sessionId} failed`))) {
      return `${subject} errored`;
    }
    return title;
  }
  if (kind === "task_done") {
    if (!title || (sessionId && title === `${sessionId} finished`)) return `${subject} finished`;
    const genericTitles = new Set([
      context?.label?.trim(),
      context?.command?.trim(),
      compactSessionId(sessionId ?? ""),
      "service",
      "shell",
    ]);
    if (genericTitles.has(title)) return `${subject} finished`;
    return title;
  }
  if (!title) return subject;
  if (title.includes(subject)) return title;
  if (sessionId && title.includes(sessionId)) return title.replace(sessionId, subject);
  return `${subject}: ${title}`;
}

export function contextualizeAlertInput(
  input: AlertPublishInput,
  context?: SessionAlertDisplayContext,
): AlertPublishInput {
  return {
    ...input,
    title: sessionAlertTitle(input.kind, input.sessionId, input.title, context),
    worktreePath: input.worktreePath ?? context?.worktreePath,
  };
}
