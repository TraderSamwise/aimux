export function renderOverlayBox(lines: string[], cols: number, rows: number, style: "blue" | "red" = "blue"): string {
  const boxWidth = Math.max(...lines.map((line) => line.length)) + 4;
  const startRow = Math.floor((rows - lines.length - 2) / 2);
  const startCol = Math.floor((cols - boxWidth) / 2);
  const borderStyle = style === "red" ? "\x1b[41;97m" : "\x1b[44;97m";

  let output = "\x1b7";
  for (let i = 0; i < lines.length + 2; i++) {
    const row = startRow + i;
    output += `\x1b[${row};${startCol}H`;
    if (i === 0 || i === lines.length + 1) {
      output += `${borderStyle}${"─".repeat(boxWidth)}\x1b[0m`;
    } else {
      output += `${borderStyle}  ${lines[i - 1].padEnd(boxWidth - 2)}\x1b[0m`;
    }
  }
  output += "\x1b8";
  return output;
}
