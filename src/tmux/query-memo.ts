/**
 * One synchronous scope, one answer per tmux question.
 *
 * Building a desktop-state snapshot asks tmux the same things repeatedly — 315
 * `list-windows` and 137 `show-window-options` forks in a 66.8s window, measured.
 * Each fork blocks this event loop, and the daemon hosts every project service in
 * this one process, so that is dead time for every project at once.
 *
 * Scoped to a single synchronous build rather than cached with a TTL, which is
 * what makes it safe: `buildDesktopStateSnapshot` contains no `await`, so the
 * event loop cannot interleave, the memo cannot outlive the call, and no other
 * code path can observe it. A snapshot is already a point-in-time view — asking
 * tmux the same question twice while assembling one was never buying freshness.
 *
 * The same shape as `withWorktreeMemo` in `src/worktree.ts`, which does this for
 * git subprocesses, for the same reason.
 */

type MemoEntry = { ok: true; value: unknown } | { ok: false; error: unknown };

let memo: Map<string, MemoEntry> | null = null;

/**
 * Reentrant: a nested call inherits the outer scope instead of starting its own,
 * so a memoized helper calling another one does not silently reset the cache.
 */
export function withTmuxQueryMemo<T>(fn: () => T): T {
  if (memo) return fn();
  memo = new Map();
  try {
    return fn();
  } finally {
    memo = null;
  }
}

/**
 * Outside a scope this is a plain call — the memo is inert for every caller that
 * has not opted in, which is what keeps it from changing behaviour anywhere else.
 *
 * Throws are memoized alongside successes: a tmux query that fails once inside a
 * snapshot fails for the same reason the second time, and re-running it to
 * rediscover that costs another fork.
 */
export function memoizedTmuxQuery<T>(key: string, compute: () => T): T {
  if (!memo) return compute();
  const hit = memo.get(key);
  if (hit) {
    if (hit.ok) return hit.value as T;
    throw hit.error;
  }
  try {
    const value = compute();
    memo.set(key, { ok: true, value });
    return value;
  } catch (error) {
    memo.set(key, { ok: false, error });
    throw error;
  }
}

/** True while a scope is open; for tests and for asserting the inert default. */
export function isInTmuxQueryMemoScope(): boolean {
  return memo !== null;
}

/**
 * Invalidate everything recorded so far in the current scope.
 *
 * For the one case the scope assumption does not cover: code that mutates tmux
 * (creating, killing or renaming a window, setting an option) and then reads it
 * back within the same build. The read must not be answered from before the write.
 */
export function resetTmuxQueryMemo(): void {
  memo?.clear();
}

/**
 * tmux subcommands that only ask questions.
 *
 * Deliberately an allowlist. Anything not named here — including a subcommand
 * added later — is treated as a mutation and clears the memo, so the failure mode
 * of forgetting to classify something is a lost optimisation rather than a stale
 * read. That matters here: a desktop-state build renames windows and sets options
 * partway through and then re-reads specifically to observe the new state.
 *
 * `capture-pane` is excluded on purpose. Pane contents are the one thing that
 * genuinely changes between two reads inside a single build.
 */
export const READ_ONLY_TMUX_VERBS = new Set([
  // `tmux -V`. A version query classified as a mutation made a pure read clear
  // the whole memo.
  "-V",
  "display-message",
  "has-session",
  "list-clients",
  "list-panes",
  "list-sessions",
  "list-windows",
  "show-options",
  "show-window-options",
]);

/** The memo key: the full argv plus cwd, since cwd changes what tmux answers. */
export function tmuxQueryKey(args: readonly string[], cwd?: string): string {
  return JSON.stringify([cwd ?? "", ...args]);
}
