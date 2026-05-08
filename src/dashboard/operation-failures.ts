import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "../atomic-write.js";
import { getDashboardOperationFailuresPath } from "../paths.js";

export type DashboardOperationTargetKind = "worktree" | "agent" | "service" | "dashboard";

export interface DashboardOperationFailure {
  id: string;
  targetKind: DashboardOperationTargetKind;
  operation: string;
  title: string;
  message: string;
  createdAt: string;
  targetId?: string;
  worktreePath?: string;
  worktreeName?: string;
  cleared?: boolean;
}

interface DashboardOperationFailureState {
  version: 1;
  failures: DashboardOperationFailure[];
}

const MAX_FAILURES = 100;
const ACTIVE_FAILURE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function loadState(): DashboardOperationFailureState {
  const path = getDashboardOperationFailuresPath();
  if (!existsSync(path)) return { version: 1, failures: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as DashboardOperationFailureState;
    if (parsed.version !== 1 || !Array.isArray(parsed.failures)) {
      return { version: 1, failures: [] };
    }
    return parsed;
  } catch {
    return { version: 1, failures: [] };
  }
}

function saveState(state: DashboardOperationFailureState): void {
  writeJsonAtomic(getDashboardOperationFailuresPath(), {
    version: 1,
    failures: state.failures.slice(0, MAX_FAILURES),
  } satisfies DashboardOperationFailureState);
}

function isActiveFailure(failure: DashboardOperationFailure, now = Date.now()): boolean {
  if (failure.cleared) return false;
  const createdAt = Date.parse(failure.createdAt);
  if (!Number.isFinite(createdAt)) return true;
  return now - createdAt < ACTIVE_FAILURE_MAX_AGE_MS;
}

export function listDashboardOperationFailures(): DashboardOperationFailure[] {
  const now = Date.now();
  return loadState().failures.filter((failure) => isActiveFailure(failure, now));
}

export function addDashboardOperationFailure(input: {
  targetKind: DashboardOperationTargetKind;
  operation: string;
  title: string;
  message: string;
  targetId?: string;
  worktreePath?: string;
  worktreeName?: string;
  createdAt?: string;
}): DashboardOperationFailure {
  const now = input.createdAt ?? new Date().toISOString();
  const state = loadState();
  const failure: DashboardOperationFailure = {
    id: randomUUID(),
    targetKind: input.targetKind,
    operation: input.operation,
    title: input.title.trim() || "Operation failed",
    message: input.message.trim() || "Unknown error",
    targetId: input.targetId?.trim() || undefined,
    worktreePath: input.worktreePath?.trim() || undefined,
    worktreeName: input.worktreeName?.trim() || undefined,
    createdAt: now,
  };
  state.failures = [
    failure,
    ...state.failures.filter(
      (existing) =>
        !(
          !existing.cleared &&
          existing.targetKind === failure.targetKind &&
          existing.operation === failure.operation &&
          existing.targetId === failure.targetId &&
          existing.worktreePath === failure.worktreePath
        ),
    ),
  ];
  saveState(state);
  return failure;
}

export function clearDashboardOperationFailures(match: {
  targetKind?: DashboardOperationTargetKind;
  operation?: string;
  targetId?: string;
  worktreePath?: string;
}): number {
  const state = loadState();
  let changed = 0;
  state.failures = state.failures.map((failure) => {
    if (failure.cleared) return failure;
    if (match.targetKind && failure.targetKind !== match.targetKind) return failure;
    if (match.operation && failure.operation !== match.operation) return failure;
    if (match.targetId && failure.targetId !== match.targetId) return failure;
    if (match.worktreePath && failure.worktreePath !== match.worktreePath) return failure;
    changed += 1;
    return { ...failure, cleared: true };
  });
  if (changed > 0) saveState(state);
  return changed;
}
