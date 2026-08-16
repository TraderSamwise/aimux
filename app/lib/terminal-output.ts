import { ansiLineText, parseAnsiLines, type AnsiSpan } from "@/lib/ansi";
import type { HistoryTextSpan } from "@/lib/events";

const DIVIDER_LINE_MIN_LENGTH = 24;
const DIVIDER_LINE_MIN_RATIO = 0.9;
const DIVIDER_CONTINUATION_MIN_LENGTH = 8;
const DEFAULT_DIVIDER_WIDTH = 72;
const DEFAULT_SOFT_WRAP_COLUMN = 28;
const SOFT_WRAP_MIN_SEPARATOR_RUN = 12;
const SOFT_BREAK = "\u200B";
const DIVIDER_CHARS = new Set(["─", "━", "═", "╌", "╍", "⎯", "-", "_", "="]);
const SOFT_WRAP_SEPARATOR_CHARS = new Set(["/", "\\", ".", "-", "_", "=", ":", "?", "&", ",", ";"]);

interface TerminalOutputDisplayOptions {
  dividerWidth?: number;
  softWrapColumn?: number;
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
  const lines = parseAnsiLines(output);
  const formatted: AnsiSpan[][] = [];
  let previousWasDivider = false;

  for (const spans of lines) {
    const line = ansiLineText(spans);
    if (isDividerLine(line)) {
      if (previousWasDivider) continue;
      const indent = line.match(/^\s*/)?.[0] ?? "";
      // A rule is one run of one character, so re-emitting it as a single span
      // at the first span's style loses nothing and avoids slicing across spans.
      formatted.push([
        { text: `${indent}${line.trim().slice(0, dividerWidth)}`, style: spans[0]?.style ?? {} },
      ]);
      previousWasDivider = true;
      continue;
    }
    if (previousWasDivider && isDividerContinuationLine(line)) continue;

    formatted.push(spans);
    previousWasDivider = false;
  }

  return formatted;
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
  const formatted: string[] = [];
  let previousWasDivider = false;

  for (const line of trimTrailingTerminalChromeLines(text.split("\n"))) {
    if (isDividerLine(line)) {
      if (previousWasDivider) continue;
      const indent = line.match(/^\s*/)?.[0] ?? "";
      formatted.push(`${indent}${line.trim().slice(0, dividerWidth)}`);
      previousWasDivider = true;
      continue;
    }
    if (previousWasDivider && isDividerContinuationLine(line)) continue;

    formatted.push(softWrapLongRuns(line, softWrapColumn).text);
    previousWasDivider = false;
  }

  return formatted.join("\n");
}

export function formatRichTextSpansForDisplay(
  spans: readonly HistoryTextSpan[],
  {
    dividerWidth = DEFAULT_DIVIDER_WIDTH,
    softWrapColumn = DEFAULT_SOFT_WRAP_COLUMN,
  }: TerminalOutputDisplayOptions = {},
): HistoryTextSpan[] {
  const formatted: HistoryTextSpan[][] = [];
  let previousWasDivider = false;

  for (const lineSpans of trimTrailingTerminalChromeSpanLines(splitRichTextLines(spans))) {
    const line = richTextLineText(lineSpans);
    if (isDividerLine(line)) {
      if (previousWasDivider) continue;
      const indent = line.match(/^\s*/)?.[0] ?? "";
      formatted.push([
        {
          ...lineSpans[0],
          text: `${indent}${line.trim().slice(0, dividerWidth)}`,
        },
      ]);
      previousWasDivider = true;
      continue;
    }
    if (previousWasDivider && isDividerContinuationLine(line)) continue;

    formatted.push(softWrapLongRunSpans(lineSpans, softWrapColumn));
    previousWasDivider = false;
  }

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
    /^gpt-[\w.-]+\b.*(?:~\/|\/|context\)|permissions)/i.test(trimmed) ||
    /^claude\b.*(?:~\/|\/|context\)|permissions)/i.test(trimmed) ||
    /bypass permissions|shift\+tab|to cycle/i.test(trimmed)
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
