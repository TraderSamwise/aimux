/**
 * What the service served, and whether this view can show any more of it.
 *
 * The TUI says `[aimux showing last N lines]` whenever the window is a tail
 * (`daemon/text/host_agent.rs`), which is honest there because it asks for
 * exactly `captureLineLimit` lines once and streams them. This app asks for
 * 160 and pages back 320 at a time, so the same sentence would claim 2000
 * lines it never fetched, on every chat including a three-message one.
 */
export type AgentOutputWindow = {
  /** The window is a tail of the pane rather than the whole of it. */
  tailOnly?: boolean;
  /** The caller asked to start further back than the service would go. */
  startLineClamped?: boolean;
  /** The most lines the service will serve at once. */
  captureLineLimit?: number;
};

/**
 * Whether the window the service served begins part-way through the pane.
 *
 * The service's own fact, and the same `||` the TUI reads. True of every
 * window this app asks for, so it is a precondition rather than a reason to
 * tell the user anything.
 */
export function agentOutputWindowOmitsHead(window: AgentOutputWindow | undefined): boolean {
  if (!window) return false;
  return window.tailOnly === true || window.startLineClamped === true;
}

/**
 * Why scrolling up stopped loading more, or null while it has not stopped.
 *
 * Only once the view has paged as far back as it goes: before that, scrolling
 * fetches another page and there is nothing to explain. The number is the
 * limit the view is bounded BY, not a count of what is on screen -- the app
 * asks for 160 lines and the service reports a 2000-line limit either way.
 */
export function agentOutputHistoryFloorNotice(
  window: AgentOutputWindow | undefined,
  atHistoryFloor: boolean,
): string | null {
  if (!atHistoryFloor) return null;
  if (!agentOutputWindowOmitsHead(window)) return null;
  const limit = window?.captureLineLimit;
  if (typeof limit !== "number" || limit <= 0) {
    return "Earlier output is not loaded";
  }
  return `Earlier output is not loaded · this view goes back ${limit} lines`;
}
