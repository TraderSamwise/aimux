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
