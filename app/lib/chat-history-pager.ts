import {
  CHAT_HISTORY_PAGE_FAILURE_LIMIT,
  CHAT_OUTPUT_CAPTURE_START_LINE,
  type ChatOutputHistoryScrollMetrics,
  chatHistoryPageOutcome,
  chatHistoryPagingAllowed,
  chatHistoryPagingRetryable,
  chatHistorySeedStartLine,
  chatOutputHistoryStartLineForScroll,
} from "@/lib/chat-output-constants";

/**
 * The whole paging decision, as a value rather than a component.
 *
 * It lived in the screen, where an Expo Router route no renderer in this app
 * executes, so every gate could only read the source text. Four mutations
 * survived that -- including restoring the original bug verbatim -- because
 * grepping for a call proves the call is written, not that it decides
 * anything. Here the sequences that matter can be driven: scroll up with no
 * backend five times, serve a shallower window, recover from a failure.
 */
export type ChatHistoryPagerState = {
  /** How far back the view has asked for and been served. */
  startLine: number;
  /** Consecutive requests that were never served, within one gesture. */
  failures: number;
  /** Set once the service has shown there is no more history. */
  floorReached: boolean;
  /** Whether a page has actually arrived for this mount. */
  pagedAtLeastOnce: boolean;
  /**
   * Whether the one page a non-scrollable transcript is allowed has been
   * asked for. See `chatHistoryPagerContentSized` for why it is exactly one.
   */
  filledFromContent: boolean;
};

export function chatHistoryPagerState(storedStartLine?: number): ChatHistoryPagerState {
  return {
    startLine: chatHistorySeedStartLine(storedStartLine),
    failures: 0,
    floorReached: false,
    pagedAtLeastOnce: false,
    filledFromContent: false,
  };
}

export type ChatHistoryPagerScroll = {
  metrics: ChatOutputHistoryScrollMetrics;
  /** The surface is visible, the service is reachable, the session exists. */
  ready: boolean;
  /** A request already in flight, if any. */
  pendingStartLine: number | null;
};

/**
 * What a scroll event should do: ask for a window, or nothing.
 *
 * Returns the state to keep as well, because a scroll away from the top
 * clears the failure count -- the brake counts within one gesture, and
 * without that a service down for a moment left the pager refusing for the
 * rest of the session.
 */
export function chatHistoryPagerScrolled(
  state: ChatHistoryPagerState,
  scroll: ChatHistoryPagerScroll,
): { state: ChatHistoryPagerState; request: number | null } {
  const next = chatHistoryPagingRetryable(scroll.metrics) ? { ...state, failures: 0 } : state;
  const request = chatOutputHistoryStartLineForScroll({
    currentStartLine: next.startLine,
    enabled: scroll.ready && !next.floorReached && chatHistoryPagingAllowed(next.failures),
    metrics: scroll.metrics,
    pendingStartLine: scroll.pendingStartLine,
  });
  return { state: next, request };
}

export type ChatHistoryPagerResolution = {
  /** The window that was asked for. */
  requestedStartLine: number;
  /** Whether a snapshot was applied at all. */
  arrived: boolean;
  /** The window the service actually served, when it said. */
  appliedStartLine?: number;
};

/**
 * What a resolved request means for the state.
 *
 * `arrived` is its own fact because the served line is optional in the
 * contract: a page can arrive without one, and reading that as nothing
 * stopped paging on history already on screen.
 */
export function chatHistoryPagerResolved(
  state: ChatHistoryPagerState,
  resolution: ChatHistoryPagerResolution,
): ChatHistoryPagerState {
  if (!resolution.arrived) {
    // The content-sized latch is released too. It is spent when a page
    // ARRIVES, not when one is asked for: a request that nothing answered --
    // a share route still connecting, an endpoint hiccup on open -- would
    // otherwise burn the only ask a non-scrollable transcript gets, and there
    // is no gesture left to retry with, because the retry brake needs a
    // scroll this view cannot offer.
    return { ...state, failures: state.failures + 1, filledFromContent: false };
  }
  const outcome = chatHistoryPageOutcome({
    currentStartLine: state.startLine,
    appliedStartLine: resolution.appliedStartLine ?? resolution.requestedStartLine,
  });
  const served = { ...state, failures: 0, pagedAtLeastOnce: true };
  // Latched on "no deeper": the service has answered, and asking again every
  // time the reader reaches the top would be a request per scroll event
  // forever -- the brake cannot catch it, because a served page clears the
  // failure count.
  if (outcome.kind === "advanced") {
    return { ...served, startLine: outcome.startLine };
  }
  return { ...served, floorReached: true };
}

export const CHAT_HISTORY_PAGER_FAILURE_LIMIT = CHAT_HISTORY_PAGE_FAILURE_LIMIT;
export const CHAT_HISTORY_PAGER_INITIAL_START_LINE = CHAT_OUTPUT_CAPTURE_START_LINE;

export type ChatHistoryPagerContent = {
  metrics: ChatOutputHistoryScrollMetrics;
  /** The surface is visible, the service is reachable, the session exists. */
  ready: boolean;
  /** A request already in flight, if any. */
  pendingStartLine: number | null;
};

/**
 * What a transcript too short to scroll should do.
 *
 * A scroll handler is the only thing that pages, and a scroll node whose
 * content does not overflow emits no scroll event -- so a reader whose chat
 * holds three long answers had no gesture that could ask for a fourth. The
 * floor rule already knew this shape (`chatHistoryAtFloor` treats a
 * non-overflowing view as its own case); nothing acted on it.
 *
 * Exactly one page, latched, and that bound is the point. The service echoes
 * back whatever window it was asked for, clamped only at its own capture
 * limit, so every page reports as progress whether or not any output lies
 * behind it. Paging on each content-size change would therefore walk a
 * two-message chat to the deepest window in six requests and then tell the
 * reader they had hit the service ceiling. One page answers "there was no way
 * to ask"; the scroll handler takes over once there is something to scroll.
 *
 * The latch also stands in for the retry brake, which cannot help here:
 * `chatHistoryPagingRetryable` clears failures only after scrolling well away
 * from the top, and a view that cannot scroll never offers that gesture.
 */
export function chatHistoryPagerContentSized(
  state: ChatHistoryPagerState,
  content: ChatHistoryPagerContent,
): { state: ChatHistoryPagerState; request: number | null } {
  // Unmeasured is not the same as short. Both arrive as zero, and the two
  // callbacks that fill them -- layout and content size -- can land in either
  // order, so a view measured on only one axis would read as "overflows" and
  // never ask, or as "short" and latch on nothing. Neither is an answer, so
  // wait for both.
  const measured = content.metrics.contentHeight > 0 && content.metrics.viewportHeight > 0;
  const overflows = content.metrics.contentHeight > content.metrics.viewportHeight;
  if (!measured || state.filledFromContent || overflows) return { state, request: null };

  const request = chatOutputHistoryStartLineForScroll({
    currentStartLine: state.startLine,
    enabled: content.ready && !state.floorReached && chatHistoryPagingAllowed(state.failures),
    metrics: content.metrics,
    pendingStartLine: content.pendingStartLine,
  });
  if (request === null) return { state, request: null };
  return { state: { ...state, filledFromContent: true }, request };
}
