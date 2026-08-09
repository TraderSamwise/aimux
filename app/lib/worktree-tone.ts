import type { WorktreeBucket } from "@/lib/desktop-state";

/**
 * The same six tones Exposé tints tiles with, as hex.
 *
 * Literally the same colours: these are the xterm-256 values of the TUI's
 * `BAND_TONES`, so a worktree does not change identity when you move between the
 * terminal and the app.
 */
export const WORKTREE_TONES = [
  "#00afd7",
  "#5faf5f",
  "#d7af5f",
  "#d787d7",
  "#5fafff",
  "#ff875f",
] as const;

export interface WorktreeIdentity {
  name: string;
  branch: string;
  /** By position in the project's group list; see below. */
  tone: string;
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
 * The tone is order of appearance rather than a hash, matching Exposé: it
 * guarantees the first six worktrees in a project are mutually distinct, where
 * a hash lets two neighbours collide. Sharing the ordering with the sidebar is
 * what keeps the two surfaces agreeing about which colour a worktree is.
 *
 * Matched on path first because every project's main checkout is named "main";
 * name is the fallback for groups the service reports without one.
 */
export function worktreeIdentity(
  groups: WorktreeBucket[] | undefined,
  worktree: { path?: string; name?: string },
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
    tone: WORKTREE_TONES[index % WORKTREE_TONES.length]!,
  };
}
