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

/**
 * A worktree's tone, by its position in the project's ordered group list.
 *
 * Order of appearance rather than a hash, matching Exposé: it guarantees the first
 * six worktrees in a project are mutually distinct, where a hash lets two
 * neighbours collide. Sharing the ordering with the sidebar is what keeps the two
 * surfaces agreeing about which colour a worktree is.
 *
 * Matched on path first because every project's main checkout is named "main";
 * name is the fallback for groups the service reports without one.
 */
export function worktreeTone(
  groups: WorktreeBucket[] | undefined,
  worktree: { path?: string; name?: string },
): string | undefined {
  if (!groups?.length) return undefined;
  const index = groups.findIndex((group) =>
    worktree.path && group.path
      ? group.path === worktree.path
      : Boolean(worktree.name) && group.name === worktree.name,
  );
  if (index < 0) return undefined;
  return WORKTREE_TONES[index % WORKTREE_TONES.length];
}
