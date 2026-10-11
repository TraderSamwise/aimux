import {
  CHAT_OUTPUT_HISTORY_PAGE_TOP_THRESHOLD_PX,
  CHAT_OUTPUT_MAX_CAPTURE_START_LINE,
  type ChatOutputHistoryScrollMetrics,
} from "@/lib/chat-output-constants";

/**
 * How far back this view loads, as a positive count of lines.
 *
 * The floor the scroll pager stops at, which is the only bound this surface
 * can state as a fact: the service reports a `captureLineLimit` of its own and
 * the two are not the same number.
 */
export const CHAT_HISTORY_FLOOR_LINES = -CHAT_OUTPUT_MAX_CAPTURE_START_LINE;

/**
 * Why scrolling up stopped loading more, or null while it has not stopped.
 *
 * Says nothing about the pane. Nothing the service sends can tell a short
 * conversation from a truncated one -- `outputTailOnly` is set on
 * `start_line < 0`, so it is true of every window this app asks for, and the
 * response carries no pane length. Claiming "earlier output was dropped" would
 * be a guess; this states what the view does, which is what the user is asking
 * when the transcript stops growing.
 */
export function chatHistoryFloorNotice(atHistoryFloor: boolean): string | null {
  if (!atHistoryFloor) return null;
  return `This view loads at most the last ${CHAT_HISTORY_FLOOR_LINES} lines`;
}

/**
 * Whether a declined page means there is no further to go.
 *
 * Three things have to hold, because two paths move the cursor to the floor
 * without fetching anything: the resume read advances it before its own
 * request resolves, and a refresh with no endpoint returns immediately.
 */
export function chatHistoryAtFloor({
  currentStartLine,
  metrics,
  pagedAtLeastOnce,
}: {
  currentStartLine: number;
  metrics: ChatOutputHistoryScrollMetrics;
  pagedAtLeastOnce: boolean;
}): boolean {
  // A transcript shorter than the viewport sits at offset 0 forever, so "near
  // the top" is not evidence of anything until there is something to scroll.
  if (metrics.contentHeight <= metrics.viewportHeight) return false;
  if (metrics.offsetY > CHAT_OUTPUT_HISTORY_PAGE_TOP_THRESHOLD_PX) return false;
  // The reader has to have actually been given a page, or the cursor's value
  // says only that something else moved it.
  if (!pagedAtLeastOnce) return false;
  return currentStartLine <= CHAT_OUTPUT_MAX_CAPTURE_START_LINE;
}
