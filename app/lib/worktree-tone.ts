import type { WorktreeBucket } from "@/lib/desktop-state";
import {
  WORKTREE_COLOR_HEXES,
  worktreeColorHex,
  type WorktreeColorInput,
} from "../../src/worktree-colors";

/** The same six deterministic worktree identity tones used by the TUI, as hex. */
export const WORKTREE_TONES = WORKTREE_COLOR_HEXES;

export interface WorktreeIdentity {
  name: string;
  branch: string;
  /** Deterministic identity tone derived from the worktree path/name. */
  tone: string;
}

export function worktreeTone(input: WorktreeColorInput): string {
  return worktreeColorHex(input);
}

export function worktreeToneForBucket(bucket: WorktreeBucket, projectRoot?: string | null): string {
  return worktreeColorHex({
    path: bucket.path,
    name: bucket.name,
    projectRoot,
  });
}

/**
 * Which worktree a session belongs to, named and tinted.
 *
 * Resolved from the project's own group list rather than from the session,
 * because a running session carries only `worktreePath` — `worktreeName` and
 * `worktreeBranch` are filled in for offline sessions and left undefined for
 * live ones, which is every session you can actually be looking at. Reading
 * both the name and the tone from one lookup is also what keeps the chat
 * header's label and its coloured rail from ever naming different worktrees.
 *
 * Matched on path first because every project's main checkout is named "main";
 * name is the fallback for groups the service reports without one.
 */
export function worktreeIdentity(
  groups: WorktreeBucket[] | undefined,
  worktree: { path?: string; name?: string; projectRoot?: string | null },
): WorktreeIdentity | undefined {
  if (!groups?.length) return undefined;
  const index = groups.findIndex((group) =>
    worktree.path && group.path
      ? group.path === worktree.path
      : Boolean(worktree.name) && group.name === worktree.name,
  );
  const group = index < 0 ? undefined : groups[index];
  if (!group) return undefined;
  return {
    name: group.name,
    branch: group.branch,
    tone: worktreeToneForBucket(group, worktree.projectRoot),
  };
}
