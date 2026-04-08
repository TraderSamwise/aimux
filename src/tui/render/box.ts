function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*m/g, "");
}

function truncatePlain(input: string, max: number): string {
  if (max <= 0) return "";
  const plain = stripAnsi(input);
  if (plain.length <= max) return plain;
  if (max === 1) return "…";
  return `${plain.slice(0, max - 1)}…`;
}

export function renderOverlayBox(lines: string[], cols: number, rows: number, style: "blue" | "red" = "blue"): string {
  const maxContentWidth = Math.max(10, cols - 8);
  const measuredContentWidth = Math.max(0, ...lines.map((line) => stripAnsi(line).length));
  const contentWidth = Math.max(20, Math.min(maxContentWidth, measuredContentWidth));
  const boxWidth = Math.max(24, Math.min(cols - 2, contentWidth + 4));
  const boxHeight = Math.min(rows - 2, lines.length + 2);
  const visibleLines = lines.slice(0, Math.max(0, boxHeight - 2));
  const startRow = Math.max(1, Math.floor((rows - boxHeight) / 2));
  const startCol = Math.max(1, Math.floor((cols - boxWidth) / 2));
  const borderStyle = style === "red" ? "\x1b[41;97m" : "\x1b[44;97m";

  let output = "\x1b7";
  for (let i = 0; i < boxHeight; i++) {
    const row = startRow + i;
    output += `\x1b[${row};${startCol}H`;
    if (i === 0 || i === boxHeight - 1) {
      output += `${borderStyle}${"─".repeat(boxWidth)}\x1b[0m`;
    } else {
      const line = truncatePlain(visibleLines[i - 1] ?? "", boxWidth - 4);
      output += `${borderStyle}  ${line.padEnd(boxWidth - 4)}  \x1b[0m`;
    }
  }
  output += "\x1b8";
  return output;
}
