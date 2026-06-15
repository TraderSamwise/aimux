import { padVisible, style, visibleWidth, type Tone } from "./theme.js";

const VARIANT_TONE: Record<"blue" | "red", Tone> = { blue: "info", red: "danger" };

/**
 * Draw a centered, rounded, tinted modal box over the current screen. Each row is
 * positioned and written in full so it paints over whatever is behind it. Body lines
 * may contain ANSI styling; they are padded/truncated by visible width.
 */
export function renderOverlayBox(
  lines: string[],
  cols: number,
  rows: number,
  variant: "blue" | "red" = "blue",
): string {
  const tone = VARIANT_TONE[variant];
  const border = (segment: string): string => style(segment, tone);
  const maxContentWidth = Math.max(10, cols - 8);
  const measuredContentWidth = Math.max(0, ...lines.map((line) => visibleWidth(line)));
  const contentWidth = Math.max(20, Math.min(maxContentWidth, measuredContentWidth));
  const boxWidth = Math.max(24, Math.min(cols - 2, contentWidth + 4));
  const innerWidth = boxWidth - 4;
  const boxHeight = Math.min(rows - 2, lines.length + 2);
  const visibleLines = lines.slice(0, Math.max(0, boxHeight - 2));
  const startRow = Math.max(1, Math.floor((rows - boxHeight) / 2));
  const startCol = Math.max(1, Math.floor((cols - boxWidth) / 2));

  let output = "\x1b7";
  for (let i = 0; i < boxHeight; i++) {
    output += `\x1b[${startRow + i};${startCol}H`;
    if (i === 0) {
      output += border(`╭${"─".repeat(boxWidth - 2)}╮`);
    } else if (i === boxHeight - 1) {
      output += border(`╰${"─".repeat(boxWidth - 2)}╯`);
    } else {
      output += `${border("│")} ${padVisible(visibleLines[i - 1] ?? "", innerWidth)} ${border("│")}`;
    }
  }
  output += "\x1b8";
  return output;
}
