export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export function center(text: string, width: number): string {
  const pad = Math.max(0, Math.floor((width - stripAnsi(text).length) / 2));
  return " ".repeat(pad) + text;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

export function truncatePlain(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  return `${text.slice(0, max - 1)}…`;
}

export function truncateAnsi(text: string, max: number): string {
  if (max <= 0) return "";
  const plainLength = stripAnsi(text).length;
  const needsEllipsis = plainLength > max;
  const limit = needsEllipsis && max > 1 ? max - 1 : max;
  let visible = 0;
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\x1b") {
      const match = text.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (match) {
        out += match[0];
        i += match[0].length - 1;
        continue;
      }
    }
    if (visible >= limit) break;
    out += text[i];
    visible += 1;
  }
  if (needsEllipsis) out += "…";
  if (out.includes("\x1b[")) out += "\x1b[0m";
  return out;
}

export function wrapText(text: string, width: number): string[] {
  const plain = text.trim();
  if (!plain) return [""];
  if (width <= 8) return [truncatePlain(plain, width)];
  const words = plain.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= width) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    current = word.length > width ? truncatePlain(word, width) : word;
  }
  if (current) lines.push(current);
  return lines;
}

export function wrapKeyValue(key: string, value: string, width: number): string[] {
  const prefix = `${key}: `;
  const wrapped = wrapText(value, Math.max(8, width - prefix.length));
  return wrapped.map((line, idx) => (idx === 0 ? `${prefix}${line}` : `${" ".repeat(prefix.length)}${line}`));
}

export function composeTwoPane(left: string[], right: string[], cols: number): string[] {
  const leftWidth = Math.max(32, Math.floor(cols * 0.58));
  const rightWidth = Math.max(20, cols - leftWidth - 4);
  const height = Math.max(left.length, right.length);
  const totalWidth = leftWidth + 3 + rightWidth;
  const outerPad = Math.max(0, Math.floor((cols - totalWidth) / 2));
  const out: string[] = [];
  for (let i = 0; i < height; i++) {
    const leftLine = truncateAnsi(left[i] ?? "", leftWidth);
    const rightLine = truncateAnsi(right[i] ?? "", rightWidth);
    const leftPad = Math.max(0, leftWidth - stripAnsi(leftLine).length);
    const rightPad = Math.max(0, rightWidth - stripAnsi(rightLine).length);
    out.push(`${" ".repeat(outerPad)}${leftLine}${" ".repeat(leftPad)} │ ${rightLine}${" ".repeat(rightPad)}`);
  }
  return out;
}
