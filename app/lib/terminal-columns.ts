/**
 * How wide a rule may be before the terminal pane wraps it.
 *
 * A tool draws its rules to the width of ITS pane. Claude Code's prompt box
 * is 199 characters here, and the pane showing it is nearer 60, so an
 * untruncated border wraps into three rows -- and the box has two borders, so
 * you get six rows of line art around one input line.
 *
 * The truncation that prevents this existed already, but it was cutting to
 * `Math.max(48, chatDividerWidth * 2)`: twice the width of a CHAT BUBBLE,
 * capped at 72, so at most 144 columns. That number is derived from a
 * different pane with a different font and has nothing to do with how many
 * columns the terminal actually has. At 144 it still wrapped.
 *
 * The terminal pane's font is fixed, so its column count is arithmetic rather
 * than a guess: measured in Chrome, `ui-monospace, SFMono-Regular, Menlo,
 * Monaco, Consolas, monospace` at 12px advances 7.2246875px per character,
 * and a box-drawing `─` advances exactly the same as an ASCII glyph.
 */
export const TERMINAL_CHAR_WIDTH = 7.2246875;

/** `paddingHorizontal: 12` on the scroll content, both sides. */
export const TERMINAL_CONTENT_PADDING = 24;

/**
 * Columns given away so a rule never reaches the edge.
 *
 * Truncating a rule early is invisible -- it is a horizontal line, and a
 * slightly shorter one reads identically. Truncating it late wraps it into a
 * second row, which is the entire bug. The costs are not symmetric, so this
 * is deliberately generous rather than exact.
 *
 * It also absorbs the one thing the arithmetic cannot know: the advance width
 * above was measured on one Mac with SF Mono available. Where the stack falls
 * back to a wider face, the real column count is lower than the computed one,
 * and without slack that is a wrap.
 */
export const TERMINAL_COLUMN_SAFETY = 8;

/** Below this a rule stops reading as a rule, so stop shrinking. */
export const MIN_TERMINAL_DIVIDER_WIDTH = 16;

/**
 * Columns a rule may occupy in a pane of `paneWidth` device-independent
 * pixels.
 *
 * `fallback` covers the first render, before layout has measured anything:
 * returning 0 there would truncate every rule to nothing.
 */
export function terminalDividerColumns(paneWidth: number, fallback: number): number {
  if (!Number.isFinite(paneWidth) || paneWidth <= 0) {
    return fallback;
  }
  const usable = paneWidth - TERMINAL_CONTENT_PADDING;
  const columns = Math.floor(usable / TERMINAL_CHAR_WIDTH) - TERMINAL_COLUMN_SAFETY;
  return Math.max(MIN_TERMINAL_DIVIDER_WIDTH, columns);
}
