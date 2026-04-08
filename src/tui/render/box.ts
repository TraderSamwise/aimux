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
  const contentWidth = Math.max(20, Math.min(cols - 6, Math.max(...lines.map((line) => stripAnsi(line).length))));
  const boxWidth = Math.min(cols - 2, contentWidth + 4);
  const boxHeight = lines.length + 2;
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
      const line = truncatePlain(lines[i - 1] ?? "", boxWidth - 2);
      output += `${borderStyle}  ${line.padEnd(boxWidth - 2)}\x1b[0m`;
    }
  }
  output += "\x1b8";
  return output;
}
