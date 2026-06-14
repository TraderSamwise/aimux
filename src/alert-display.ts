import { basename } from "node:path";
import type { SessionMetadata } from "./metadata-store.js";
import type { AlertEvent, AlertKind } from "./project-events.js";
import { getRepoRoot } from "./paths.js";

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

function projectDisplayContext(input: AlertPublishInput): { projectName?: string; projectRoot?: string } {
  if (input.projectName?.trim() || input.projectRoot?.trim()) {
    return {
      projectName: input.projectName?.trim() || undefined,
      projectRoot: input.projectRoot?.trim() || undefined,
    };
  }
  try {
    const projectRoot = getRepoRoot();
    return { projectName: basename(projectRoot), projectRoot };
  } catch {
    return {};
  }
}

export function alertCategoryLabel(input: Pick<AlertPublishInput, "kind" | "interaction">): string {
  if (input.kind === "interaction_request") {
    if (input.interaction?.type === "permission") return "Permission";
    if (input.interaction?.type === "exit_plan") return "Plan review";
    if (input.interaction?.type === "question") return "Question";
    if (input.interaction?.type === "input") return "Input";
    return "Interaction";
  }
  if (input.kind === "needs_input") return "Needs input";
  if (input.kind === "task_done") return "Done";
  if (input.kind === "task_failed") return "Error";
  if (input.kind === "blocked") return "Blocked";
  if (input.kind === "message_waiting") return "Message";
  if (input.kind === "handoff_waiting") return "Handoff";
  if (input.kind === "task_assigned") return "Task";
  if (input.kind === "review_waiting") return "Review";
  return "Activity";
}

export function alertReasonLabel(input: Pick<AlertPublishInput, "kind" | "dedupeKey" | "interaction">): string {
  if (input.kind === "interaction_request") {
    if (input.interaction?.telemetry) return "Tool prompt observed";
    if (input.interaction?.type === "permission") return "Agent requested permission";
    if (input.interaction?.type === "exit_plan") return "Agent requested plan review";
    if (input.interaction?.type === "question") return "Agent asked a question";
    return "Agent requested input";
  }
  if (input.kind === "needs_input") {
    if (input.dedupeKey?.startsWith("idle-needs-input:")) return "Agent stopped after a turn";
    return "Agent is waiting for input";
  }
  if (input.kind === "task_done") return "Agent or service finished";
  if (input.kind === "task_failed") return "Agent or service errored";
  if (input.kind === "blocked") return "Agent is blocked";
  if (input.kind === "message_waiting") return "Message is waiting";
  if (input.kind === "handoff_waiting") return "Handoff is waiting";
  if (input.kind === "task_assigned") return "Task was assigned";
  if (input.kind === "review_waiting") return "Review is waiting";
  return "Notification";
}

function alertLocationTitle(input: AlertPublishInput, context?: SessionAlertDisplayContext): string {
  const project = projectDisplayContext(input);
  const projectName = project.projectName ?? "aimux";
  const worktree = input.worktreeName?.trim() || (context ? displayWorktreeLabel(context) : undefined);
  return worktree ? `${projectName} / ${worktree}` : projectName;
}

function alertMessageBody(reason: string, subjectTitle: string, message: string): string {
  const detail = message.trim();
  const subject = subjectTitle.trim();
  const parts = [reason, subject].filter(Boolean).join(": ");
  if (!detail || detail === subject || detail === parts) return parts || detail || "aimux";
  return `${parts} - ${detail}`;
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
  const project = projectDisplayContext(input);
  const categoryLabel = input.categoryLabel?.trim() || alertCategoryLabel(input);
  const reasonLabel = input.reasonLabel?.trim() || alertReasonLabel(input);
  const subjectTitle = sessionAlertTitle(input.kind, input.sessionId, input.title, context);
  const worktreeName = input.worktreeName?.trim() || (context ? displayWorktreeLabel(context) : undefined);
  return {
    ...input,
    title: `[${categoryLabel}] ${alertLocationTitle(input, context)}`,
    message: alertMessageBody(reasonLabel, subjectTitle, input.message),
    projectName: project.projectName,
    projectRoot: project.projectRoot,
    worktreePath: input.worktreePath ?? context?.worktreePath,
    worktreeName,
    branch: input.branch ?? context?.branch,
    categoryLabel,
    reasonLabel,
  };
}
