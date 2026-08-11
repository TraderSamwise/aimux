import { ansiLineText, parseAnsiLines, type AnsiSpan } from "@/lib/ansi";
import type { HistoryTextSpan } from "@/lib/events";

const DIVIDER_LINE_MIN_LENGTH = 24;
const DIVIDER_LINE_MIN_RATIO = 0.9;
const DEFAULT_DIVIDER_WIDTH = 72;
const DIVIDER_CHARS = new Set(["─", "━", "═", "╌", "╍", "⎯", "-", "_", "="]);

interface TerminalOutputDisplayOptions {
  dividerWidth?: number;
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

    formatted.push(spans);
    previousWasDivider = false;
  }

  return formatted;
}

export function formatPlainTextForDisplay(
  text: string,
  { dividerWidth = DEFAULT_DIVIDER_WIDTH }: TerminalOutputDisplayOptions = {},
): string {
  const formatted: string[] = [];
  let previousWasDivider = false;

  for (const line of text.split("\n")) {
    if (isDividerLine(line)) {
      if (previousWasDivider) continue;
      const indent = line.match(/^\s*/)?.[0] ?? "";
      formatted.push(`${indent}${line.trim().slice(0, dividerWidth)}`);
      previousWasDivider = true;
      continue;
    }

    formatted.push(line);
    previousWasDivider = false;
  }

  return formatted.join("\n");
}

export function formatRichTextSpansForDisplay(
  spans: readonly HistoryTextSpan[],
  { dividerWidth = DEFAULT_DIVIDER_WIDTH }: TerminalOutputDisplayOptions = {},
): HistoryTextSpan[] {
  const formatted: HistoryTextSpan[][] = [];
  let previousWasDivider = false;

  for (const lineSpans of splitRichTextLines(spans)) {
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

    formatted.push(lineSpans);
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

function richTextLineText(spans: readonly HistoryTextSpan[]): string {
  return spans.map((span) => span.text).join("");
}

function isDividerLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < DIVIDER_LINE_MIN_LENGTH) return false;

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
    dividerChars >= DIVIDER_LINE_MIN_LENGTH &&
    countedChars > 0 &&
    dividerChars / countedChars >= DIVIDER_LINE_MIN_RATIO
  );
}
