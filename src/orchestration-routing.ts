export interface RoutingCandidate {
  id: string;
  tool?: string;
  role?: string;
  worktreePath?: string;
  status?: string;
  exited?: boolean;
}

export interface RouteTargetInput {
  candidates: RoutingCandidate[];
  to?: string;
  assignee?: string;
  tool?: string;
  worktreePath?: string;
}

function samePath(a?: string, b?: string): boolean {
  return (a ?? "") === (b ?? "");
}

function scoreCandidate(candidate: RoutingCandidate, input: RouteTargetInput): number {
  let score = 0;
  if (input.worktreePath && samePath(candidate.worktreePath, input.worktreePath)) score += 10;
  if (input.assignee && candidate.role === input.assignee) score += 8;
  if (input.tool && candidate.tool === input.tool) score += 6;
  if (candidate.status === "idle") score += 3;
  else if (candidate.status === "waiting") score += 2;
  else if (candidate.status === "running") score += 1;
  return score;
}

export function resolveOrchestrationTarget(input: RouteTargetInput): RoutingCandidate | undefined {
  if (input.to) {
    return input.candidates.find((candidate) => candidate.id === input.to && !candidate.exited);
  }

  const filtered = input.candidates.filter((candidate) => {
    if (candidate.exited) return false;
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
