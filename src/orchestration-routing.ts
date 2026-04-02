import type { SessionAvailability } from "./session-semantics.js";

export interface RoutingCandidate {
  id: string;
  tool?: string;
  role?: string;
  worktreePath?: string;
  status?: string;
  availability?: SessionAvailability;
  workflowPressure?: number;
  exited?: boolean;
}

export interface RouteTargetInput {
  candidates: RoutingCandidate[];
  to?: string | string[];
  assignee?: string;
  tool?: string;
  worktreePath?: string;
}

function samePath(a?: string, b?: string): boolean {
  return (a ?? "") === (b ?? "");
}

function explicitRecipients(input: RouteTargetInput): string[] {
  const explicit = Array.isArray(input.to) ? input.to : input.to ? [input.to] : [];
  return [...new Set(explicit.map((value) => value.trim()).filter(Boolean))];
}

function scoreCandidate(candidate: RoutingCandidate, input: RouteTargetInput): number {
  let score = 0;
  if (input.worktreePath && samePath(candidate.worktreePath, input.worktreePath)) score += 10;
  if (input.assignee && candidate.role === input.assignee) score += 8;
  if (input.tool && candidate.tool === input.tool) score += 6;
  if (candidate.availability === "available") score += 5;
  else if (candidate.availability === "busy") score += 3;
  else if (candidate.availability === "needs_input") score += 1;
  if (candidate.status === "idle") score += 3;
  else if (candidate.status === "waiting") score += 2;
  else if (candidate.status === "running") score += 1;
  score -= Math.min(candidate.workflowPressure ?? 0, 20);
  return score;
}

export function resolveOrchestrationTarget(input: RouteTargetInput): RoutingCandidate | undefined {
  const explicit = explicitRecipients(input);
  if (explicit.length > 0) {
    return explicit
      .map((id) => input.candidates.find((candidate) => candidate.id === id && !candidate.exited))
      .find(Boolean);
  }

  const filtered = input.candidates.filter((candidate) => {
    if (candidate.exited) return false;
    if (candidate.availability === "blocked" || candidate.availability === "offline") return false;
    if (input.assignee && candidate.role !== input.assignee) return false;
    if (input.tool && candidate.tool !== input.tool) return false;
    if (input.worktreePath && !samePath(candidate.worktreePath, input.worktreePath)) return false;
    return true;
  });

  if (filtered.length === 0) return undefined;

  return [...filtered].sort(
    (a, b) => scoreCandidate(b, input) - scoreCandidate(a, input) || a.id.localeCompare(b.id),
  )[0];
}

export function resolveOrchestrationRecipients(input: RouteTargetInput): string[] {
  const explicit = explicitRecipients(input);
  if (explicit.length > 0) {
    const live = new Set(input.candidates.filter((candidate) => !candidate.exited).map((candidate) => candidate.id));
    return explicit.filter((id) => live.has(id));
  }

  const filtered = input.candidates.filter((candidate) => {
    if (candidate.exited) return false;
    if (candidate.availability === "blocked" || candidate.availability === "offline") return false;
    if (input.assignee && candidate.role !== input.assignee) return false;
    if (input.tool && candidate.tool !== input.tool) return false;
    if (input.worktreePath && !samePath(candidate.worktreePath, input.worktreePath)) return false;
    return true;
  });
  return [...filtered]
    .sort((a, b) => scoreCandidate(b, input) - scoreCandidate(a, input) || a.id.localeCompare(b.id))
    .map((candidate) => candidate.id);
}
