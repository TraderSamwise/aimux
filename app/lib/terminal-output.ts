import { ansiLineText, parseAnsiLines, type AnsiSpan } from "@/lib/ansi";
import { CHAT_OUTPUT_MAX_CAPTURE_LINES } from "@/lib/chat-output-constants";
import type { HistoryTextSpan } from "@/lib/events";

const DIVIDER_LINE_MIN_LENGTH = 24;
const DIVIDER_LINE_MIN_RATIO = 0.9;
const DIVIDER_CONTINUATION_MIN_LENGTH = 8;
const DEFAULT_DIVIDER_WIDTH = 72;
// How much blank space a single wrapped rule may contain. The rows of one
// wrapped rule are adjacent by construction, so one blank is slack for a tool
// that pads its rule; more than that is two different pieces of output, and
// swallowing the gap would weld them together.
const MAX_DIVIDER_RUN_GAP_LINES = 1;
const DEFAULT_SOFT_WRAP_COLUMN = 28;
const SOFT_WRAP_MIN_SEPARATOR_RUN = 12;
const SOFT_BREAK = "\u200B";
const DIVIDER_CHARS = new Set(["─", "━", "═", "╌", "╍", "⎯", "-", "_", "="]);
const SOFT_WRAP_SEPARATOR_CHARS = new Set(["/", "\\", ".", "-", "_", "=", ":", "?", "&", ",", ";"]);

interface TerminalOutputDisplayOptions {
  dividerWidth?: number;
  softWrapColumn?: number;
}

export function terminalOutputTail(
  output: string,
  maxLines = CHAT_OUTPUT_MAX_CAPTURE_LINES,
): string {
  return output.replace(/\r/g, "").split("\n").slice(-maxLines).join("\n");
}

interface DividerCollapse<T> {
  /** The line's visible text, with any styling stripped. */
  text(line: T): string;
  /** The same line re-emitted as a single capped rule. */
  renderDivider(line: T, capped: string): T;
  /** Any line that is not part of a rule run. */
  passthrough(line: T): T;
}

/**
 * Keep the first rule of a wrapped run and drop the rest.
 *
 * A tool draws its rules to the width of ITS pane, so in a narrower view one
 * rule arrives as several rows: a full-width row, then short residue, and --
 * the case this missed for a long time -- sometimes blank rows in between.
 *
 * A blank row is neither a divider nor a continuation, so the previous version
 * of this fell through to the passthrough branch and reset the run, and every
 * rule after a gap looked like a fresh one. That is the stack of rules running
 * down the pane in Sam's screenshot.
 *
 * So a blank inside a run is HELD rather than emitted or discarded, because
 * which it is cannot be known yet: if a rule follows, the blank was part of
 * the wrap and goes with it; if real text follows, the blank was the author's
 * spacing and is kept. Deciding at the next real line is the whole trick.
 *
 * One pass for all three renderers. It was three copies of this loop, which is
 * how the plain-text one and the styled one could disagree about the same
 * output -- and when this bug was last attacked, only some of them were fixed.
 */
function collapseDividerRuns<T>(
  lines: readonly T[],
  dividerWidth: number,
  adapter: DividerCollapse<T>,
): T[] {
  const out: T[] = [];
  let inRun = false;
  let heldBlanks: T[] = [];

  // Held blanks are ordinary lines once they are kept, so they go through the
  // same passthrough as any other -- pushing them raw would quietly skip
  // whatever it does the moment it starts touching whitespace.
  const flushHeld = () => {
    for (const blank of heldBlanks) out.push(adapter.passthrough(blank));
    heldBlanks = [];
  };

  for (const line of lines) {
    const raw = adapter.text(line);

    if (isDividerLine(raw)) {
      heldBlanks = [];
      if (inRun) continue;
      const indent = raw.match(/^\s*/)?.[0] ?? "";
      out.push(adapter.renderDivider(line, `${indent}${raw.trim().slice(0, dividerWidth)}`));
      inRun = true;
      continue;
    }

    if (inRun && isDividerContinuationLine(raw)) {
      heldBlanks = [];
      continue;
    }

    if (inRun && raw.trim().length === 0) {
      if (heldBlanks.length < MAX_DIVIDER_RUN_GAP_LINES) {
        heldBlanks.push(line);
        continue;
      }
      // Too much blank space to be one wrapped rule. Everything held is real
      // spacing between two separate things, and the run is over -- without
      // this, a rule, ten empty rows, and the next command's rule collapse
      // into one line and the two commands are welded together.
      flushHeld();
      out.push(adapter.passthrough(line));
      inRun = false;
      continue;
    }

    flushHeld();
    out.push(adapter.passthrough(line));
    inRun = false;
  }

  // Trailing blanks never got a following line to classify them, so they are
  // just the end of the output.
  flushHeld();
  return out;
}

/**
 * The pane as styled lines: tmux's colours kept, its full-width rules cut down.
 *
 * A tool draws its rules to the width of *its* pane, which is not the width of
 * this view, so a wrapped rule arrives as two or three rows of box characters.
 * They are capped to one and de-duplicated.
 */
export function formatTerminalOutputForDisplay(
  output: string,
  { dividerWidth = DEFAULT_DIVIDER_WIDTH }: TerminalOutputDisplayOptions = {},
): AnsiSpan[][] {
  return collapseDividerRuns<AnsiSpan[]>(parseAnsiLines(output), dividerWidth, {
    text: ansiLineText,
    // A rule is one run of one character, so re-emitting it as a single span
    // at the first span's style loses nothing and avoids slicing across spans.
    renderDivider: (spans, capped) => [{ text: capped, style: spans[0]?.style ?? {} }],
    passthrough: (spans) => spans,
  });
}

export function formatTerminalOutputPlainLinesForDisplay(
  output: string,
  options: TerminalOutputDisplayOptions = {},
): string[] {
  return formatTerminalOutputForDisplay(output, options).map(ansiLineText);
}

export function formatPlainTextForDisplay(
  text: string,
  {
    dividerWidth = DEFAULT_DIVIDER_WIDTH,
    softWrapColumn = DEFAULT_SOFT_WRAP_COLUMN,
  }: TerminalOutputDisplayOptions = {},
): string {
  return collapseDividerRuns(trimTrailingTerminalChromeLines(text.split("\n")), dividerWidth, {
    text: (line) => line,
    renderDivider: (_line, capped) => capped,
    passthrough: (line) => softWrapLongRuns(line, softWrapColumn).text,
  }).join("\n");
}

export function formatRichTextSpansForDisplay(
  spans: readonly HistoryTextSpan[],
  {
    dividerWidth = DEFAULT_DIVIDER_WIDTH,
    softWrapColumn = DEFAULT_SOFT_WRAP_COLUMN,
  }: TerminalOutputDisplayOptions = {},
): HistoryTextSpan[] {
  const formatted = collapseDividerRuns<HistoryTextSpan[]>(
    trimTrailingTerminalChromeSpanLines(splitRichTextLines(spans)),
    dividerWidth,
    {
      text: richTextLineText,
      renderDivider: (lineSpans, capped) => [{ ...lineSpans[0], text: capped }],
      passthrough: (lineSpans) => softWrapLongRunSpans(lineSpans, softWrapColumn),
    },
  );

  return joinRichTextLines(formatted);
}

function splitRichTextLines(spans: readonly HistoryTextSpan[]): HistoryTextSpan[][] {
  const lines: HistoryTextSpan[][] = [[]];
  for (const span of spans) {
    const chunks = span.text.split("\n");
    for (let index = 0; index < chunks.length; index += 1) {
      if (index > 0) lines.push([]);
      const text = chunks[index] ?? "";
      if (text) lines[lines.length - 1]!.push({ ...span, text });
    }
  }
  return lines;
}

function joinRichTextLines(lines: readonly (readonly HistoryTextSpan[])[]): HistoryTextSpan[] {
  const next: HistoryTextSpan[] = [];
  lines.forEach((line, index) => {
    if (index > 0) next.push({ text: "\n" });
    next.push(...line);
  });
  return next;
}

function trimTrailingTerminalChromeLines(lines: readonly string[]): string[] {
  let end = lines.length;
  let sawChrome = false;

  while (end > 0) {
    const line = lines[end - 1] ?? "";
    if (!line.trim()) {
      if (!sawChrome) break;
      end -= 1;
      continue;
    }
    if (!isTrailingTerminalChromeLine(line)) break;
    sawChrome = true;
    end -= 1;
  }

  return sawChrome ? lines.slice(0, end) : [...lines];
}

function trimTrailingTerminalChromeSpanLines(
  lines: readonly (readonly HistoryTextSpan[])[],
): HistoryTextSpan[][] {
  let end = lines.length;
  let sawChrome = false;

  while (end > 0) {
    const line = lines[end - 1] ?? [];
    const text = richTextLineText(line);
    if (!text.trim()) {
      if (!sawChrome) break;
      end -= 1;
      continue;
    }
    if (!isTrailingTerminalChromeLine(text)) break;
    sawChrome = true;
    end -= 1;
  }

  return lines.slice(0, end).map((line) => [...line]);
}

function isTrailingTerminalChromeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return (
    isDividerLine(trimmed) ||
    isDividerContinuationLine(trimmed) ||
    /^[›>❯]$/.test(trimmed) ||
    /^[—–-]\s*Worked\s+for\s+\d+(?:ms|s|m|h)\b/i.test(trimmed) ||
    /^\d+\s+background terminals? running\b.*\/ps\b.*\/stop\b/i.test(trimmed) ||
    /^[\w.-]+@[\w.-]+\s+.*(?:~\/|\/Users\/|\/home\/|\/)\S+\s+(?:[\w./-]+\s+)?(?:master|main|feat\/|fix\/|chore\/|release\/|\([^)]+\))/i.test(
      trimmed,
    ) ||
    /^gpt-[\w.-]+\b.*(?:~\/|\/|context\)|permissions)/i.test(trimmed) ||
    /^claude\b.*(?:~\/|\/|context\)|permissions)/i.test(trimmed) ||
    /bypass permissions|shift\+tab|to cycle|←\s*for agents/i.test(trimmed)
  );
}

function richTextLineText(spans: readonly HistoryTextSpan[]): string {
  return spans.map((span) => span.text).join("");
}

function softWrapLongRunSpans(
  spans: readonly HistoryTextSpan[],
  softWrapColumn: number,
): HistoryTextSpan[] {
  let runLength = 0;

  return spans.map((span) => {
    const wrapped = softWrapLongRuns(span.text, softWrapColumn, runLength);
    runLength = wrapped.trailingRunLength;
    return { ...span, text: wrapped.text };
  });
}

function softWrapLongRuns(
  text: string,
  softWrapColumn: number,
  initialRunLength = 0,
): { text: string; trailingRunLength: number } {
  const maxRunLength = Math.max(8, softWrapColumn);
  let runLength = initialRunLength;
  let next = "";
  const chars = Array.from(text);

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!;
    next += char;
    if (/\s/.test(char)) {
      runLength = 0;
      continue;
    }

    runLength += 1;
    const separatorBreak =
      runLength >= SOFT_WRAP_MIN_SEPARATOR_RUN && SOFT_WRAP_SEPARATOR_CHARS.has(char);
    const upcomingSeparator = chars
      .slice(index + 1, index + 5)
      .some((nextChar) => SOFT_WRAP_SEPARATOR_CHARS.has(nextChar));
    if (separatorBreak || (runLength >= maxRunLength && !upcomingSeparator)) {
      next += SOFT_BREAK;
      runLength = 0;
    }
  }

  return { text: next, trailingRunLength: runLength };
}

function isDividerLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < DIVIDER_LINE_MIN_LENGTH) return false;
  return isDividerRun(trimmed, DIVIDER_LINE_MIN_LENGTH);
}

function isDividerContinuationLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < DIVIDER_CONTINUATION_MIN_LENGTH) return false;
  return isDividerRun(trimmed, DIVIDER_CONTINUATION_MIN_LENGTH);
}

function isDividerRun(trimmed: string, minLength: number): boolean {
  let dividerChars = 0;
  let otherChars = 0;
  for (const char of Array.from(trimmed)) {
    if (DIVIDER_CHARS.has(char)) {
      dividerChars += 1;
    } else if (char.trim().length > 0) {
      otherChars += 1;
    }
  }

  const countedChars = dividerChars + otherChars;
  return (
    dividerChars >= minLength &&
    countedChars > 0 &&
    dividerChars / countedChars >= DIVIDER_LINE_MIN_RATIO
  );
}
