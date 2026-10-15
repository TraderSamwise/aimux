export const CHAT_OUTPUT_INITIAL_CAPTURE_START_LINE = -160;
export const CHAT_OUTPUT_HISTORY_PAGE_LINES = 320;
export const CHAT_OUTPUT_MAX_CAPTURE_START_LINE = -2_000;
export const CHAT_OUTPUT_CAPTURE_START_LINE = CHAT_OUTPUT_INITIAL_CAPTURE_START_LINE;
export const CHAT_OUTPUT_HISTORY_PAGE_TOP_THRESHOLD_PX = 96;

export type ChatOutputHistoryScrollMetrics = {
  contentHeight: number;
  offsetY: number;
  viewportHeight: number;
};

export function nextChatOutputCaptureStartLine(current: number): number {
  return Math.max(CHAT_OUTPUT_MAX_CAPTURE_START_LINE, current - CHAT_OUTPUT_HISTORY_PAGE_LINES);
}

export function chatOutputHistoryStartLineForScroll({
  currentStartLine,
  enabled = true,
  metrics,
  pendingStartLine = null,
}: {
  currentStartLine: number;
  enabled?: boolean;
  metrics: ChatOutputHistoryScrollMetrics;
  pendingStartLine?: number | null;
}): number | null {
  if (!enabled || pendingStartLine !== null) return null;
  if (metrics.offsetY > CHAT_OUTPUT_HISTORY_PAGE_TOP_THRESHOLD_PX) return null;
  const nextStartLine = nextChatOutputCaptureStartLine(currentStartLine);
  return nextStartLine < currentStartLine ? nextStartLine : null;
}

/**
 * How many pages in a row may fail before the pager stops asking.
 *
 * The cursor used to advance on a fetch that never happened, which walked it
 * to the floor and -- by accident -- stopped the pager. Holding the cursor
 * still removes that brake, so the limit has to be explicit: one request per
 * scroll event against a failing service, forever, is worse than the bug.
 */
export const CHAT_HISTORY_PAGE_FAILURE_LIMIT = 3;

/** What a requested history page turned out to be. */
export type ChatHistoryPageOutcome =
  | { kind: "advanced"; startLine: number }
  | { kind: "no-deeper-history" }
  | { kind: "not-served" };

/**
 * What a requested history page means for the cursor.
 *
 * `appliedStartLine` is what the service actually served, echoed back on the
 * snapshot, NOT what was asked for. The two differ: a service clamps the
 * request to its own capture limit, and the old code advanced the cursor to
 * the requested depth regardless -- so every later page asked for a window
 * nothing would ever serve. `undefined` means nothing arrived at all, which is
 * what `refreshOutputSnapshot` reports when there is no endpoint or session: a
 * shared chat, or a service that is down.
 *
 * A page that arrives without going deeper is the real floor. The constant
 * floor is only this view's own bound; the service has one of its own and
 * cannot be asked for it, so the honest signal is asking and learning that
 * there is no more.
 */
export function chatHistoryPageOutcome({
  currentStartLine,
  appliedStartLine,
}: {
  currentStartLine: number;
  appliedStartLine: number | undefined;
}): ChatHistoryPageOutcome {
  if (appliedStartLine === undefined) return { kind: "not-served" };
  if (appliedStartLine >= currentStartLine) return { kind: "no-deeper-history" };
  return { kind: "advanced", startLine: appliedStartLine };
}

/**
 * Where a re-entered chat's cursor starts, given what the store already holds.
 *
 * Seeding from the stored transcript stops a re-entered session re-walking
 * windows it already has. But seeding all the way to the floor makes the pager
 * a dead end: `chatOutputHistoryStartLineForScroll` declines once there is
 * nothing deeper to ask for, and `chatHistoryAtFloor` needs a page THIS mount
 * was given -- so scrolling up would do nothing and say nothing. The stored
 * line can also outlive the pane it described, so it always leaves one page of
 * room to ask and let the service answer.
 */
export function chatHistorySeedStartLine(storedStartLine: number | undefined): number {
  if (storedStartLine === undefined) return CHAT_OUTPUT_CAPTURE_START_LINE;
  const deepestSeed = CHAT_OUTPUT_MAX_CAPTURE_START_LINE + CHAT_OUTPUT_HISTORY_PAGE_LINES;
  return Math.min(CHAT_OUTPUT_CAPTURE_START_LINE, Math.max(storedStartLine, deepestSeed));
}

/**
 * Whether the pager should keep asking after this many failures in a row.
 */
export function chatHistoryPagingAllowed(consecutiveFailures: number): boolean {
  return consecutiveFailures < CHAT_HISTORY_PAGE_FAILURE_LIMIT;
}
