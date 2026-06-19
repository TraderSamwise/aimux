import { center, composeTwoPane, stripAnsi, truncateAnsi } from "./text.js";

/**
 * The shared TUI screen layout, hoisted from the dashboard so every screen composes the same
 * way: a centered content block, a scrolling main column with ▲/▼ affordances, an optional
 * right details pane separated by whitespace (no vertical divider), and a full-width footer.
 * The dashboard and all subscreens render through this so their chrome stays uniform.
 */
export interface ScreenFrameInput {
  cols: number;
  rows: number;
  /** Header block (leading blank, title, full-width rule, trailing blank). */
  header: string[];
  /** Main column lines (2-space gutter, not pre-centered). */
  content: string[];
  /** Pre-styled footer hint lines (no rule, no indent); the frame adds both. */
  footerLines: string[];
  /** Index into `content` to keep visible; -1 to disable auto-scroll. */
  focusLine: number;
  /** Incoming persisted scroll offset (dashboard); subscreens pass 0/omit. */
  scrollOffset?: number;
  /** Show the right details pane when it both fits and the caller wants it. */
  twoPane?: boolean;
  /** Builds the right pane to an exact width/height; only called when twoPane. */
  rightPanel?: (panelWidth: number, height: number) => string[];
}

export interface ScreenFrameResult {
  frame: string;
  scrollOffset: number;
}

// Block geometry shared with the dashboard: a 72-floor centered block, 58% left column.
export function screenContentWidth(cols: number): number {
  return Math.max(72, cols);
}
export function screenLeftWidth(cols: number): number {
  return Math.max(32, Math.floor(screenContentWidth(cols) * 0.58));
}

export function composeScreenFrame(input: ScreenFrameInput): ScreenFrameResult {
  const { cols, rows, header, content } = input;
  const contentWidth = screenContentWidth(cols);
  const leftWidth = screenLeftWidth(cols);
  const centerInBlock = (line: string): string => truncateAnsi(center(line, contentWidth), cols);

  const footerIndent = "  ";
  const footer: string[] = [
    "─".repeat(Math.max(0, cols)),
    ...input.footerLines.map((line) => truncateAnsi(`${footerIndent}${line}`, cols)),
  ];

  const viewportHeight = Math.max(1, rows - header.length - footer.length);
  let scrollOffset = input.scrollOffset ?? 0;
  const focusLine = input.focusLine;
  // A focused card spans from its marker to the next blank line; reveal its whole body.
  let focusEnd = focusLine;
  while (focusEnd >= 0 && focusEnd + 1 < content.length && stripAnsi(content[focusEnd + 1] ?? "").trim() !== "") {
    focusEnd++;
  }
  const maxScroll = Math.max(0, content.length - viewportHeight);
  if (focusLine >= 0) {
    if (focusLine < scrollOffset + 1) {
      scrollOffset = Math.max(0, focusLine - 1);
    } else if (focusEnd >= scrollOffset + viewportHeight - 1) {
      scrollOffset = Math.min(maxScroll, focusEnd - viewportHeight + 2);
      if (focusLine < scrollOffset + 1) scrollOffset = Math.max(0, focusLine - 1);
    }
  }
  scrollOffset = Math.min(scrollOffset, maxScroll);

  const visible = content.slice(scrollOffset, scrollOffset + viewportHeight);
  const canScrollUp = scrollOffset > 0;
  const canScrollDown = scrollOffset < maxScroll;
  if (canScrollUp && visible.length > 0) visible[0] = centerInBlock("\x1b[2m▲ more ▲\x1b[0m");
  if (canScrollDown && visible.length > 0) visible[visible.length - 1] = centerInBlock("\x1b[2m▼ more ▼\x1b[0m");
  while (visible.length < viewportHeight) visible.push("");

  let body = visible;
  if (input.twoPane && input.rightPanel) {
    const panelWidth = Math.max(20, contentWidth - leftWidth - 4);
    const rightPanel = input.rightPanel(panelWidth, viewportHeight);
    // Whitespace separator (no vertical divider), matching the dashboard.
    body = composeTwoPane(visible, rightPanel, contentWidth, "   ");
  }

  return {
    frame: "\x1b[2J\x1b[H" + [...header, ...body, ...footer].join("\r\n"),
    scrollOffset,
  };
}
