const DIVIDER_LINE_MIN_LENGTH = 24;
const DIVIDER_LINE_MIN_RATIO = 0.9;
const DEFAULT_DIVIDER_WIDTH = 72;
const DIVIDER_CHARS = new Set(["─", "━", "═", "╌", "╍", "⎯", "-", "_", "="]);

interface TerminalOutputDisplayOptions {
  dividerWidth?: number;
}

export function formatTerminalOutputForDisplay(
  output: string,
  { dividerWidth = DEFAULT_DIVIDER_WIDTH }: TerminalOutputDisplayOptions = {},
): string {
  const lines = output.split("\n");
  const formatted: string[] = [];
  let previousWasDivider = false;

  for (const line of lines) {
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
