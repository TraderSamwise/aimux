import type { RichTextMark, RichTextSpan } from "./agent-transcript-contract.js";
export type { RichTextColor, RichTextMark, RichTextSpan } from "./agent-transcript-contract.js";

interface Attributes {
  fg?: string;
  bg?: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  inverse: boolean;
}

const BASE_16 = [
  "#5c6370",
  "#e06c75",
  "#98c379",
  "#d19a66",
  "#61afef",
  "#c678dd",
  "#56b6c2",
  "#abb2bf",
  "#7f848e",
  "#ff7b86",
  "#b5e08a",
  "#e5c07b",
  "#7cc5ff",
  "#dd93ec",
  "#66d9e2",
  "#ffffff",
] as const;

const SGR_PATTERN = /\x1b\[([0-9;:]*)m/g;

function initial(): Attributes {
  return {
    fg: undefined,
    bg: undefined,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    strike: false,
    inverse: false,
  };
}

function hex(r: number, g: number, b: number): string {
  const channel = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

function xterm256(index: number): string | undefined {
  if (index < 0 || index > 255) return undefined;
  if (index < 16) return BASE_16[index];
  if (index < 232) {
    const offset = index - 16;
    const level = (value: number) => (value === 0 ? 0 : value * 40 + 55);
    return hex(level(Math.floor(offset / 36)), level(Math.floor(offset / 6) % 6), level(offset % 6));
  }
  const gray = (index - 232) * 10 + 8;
  return hex(gray, gray, gray);
}

function spanOf(text: string, attributes: Attributes): RichTextSpan {
  const fg = attributes.inverse ? attributes.bg : attributes.fg;
  const bg = attributes.inverse ? attributes.fg : attributes.bg;
  const marks: RichTextMark[] = [];
  if (attributes.bold) marks.push("bold");
  if (attributes.dim) marks.push("dim");
  if (attributes.italic) marks.push("italic");
  if (attributes.underline) marks.push("underline");
  if (attributes.strike) marks.push("strike");

  return {
    text,
    ...(marks.length > 0 ? { marks } : {}),
    ...(fg ? { foreground: { model: "rgb" as const, value: fg } } : {}),
    ...(bg ? { background: { model: "rgb" as const, value: bg } } : {}),
  };
}

function applyParams(attributes: Attributes, params: string): void {
  const codes = params.replace(/:/g, ";").split(";");
  for (let i = 0; i < codes.length; i += 1) {
    const code = Number(codes[i] === "" ? 0 : codes[i]);
    if (!Number.isFinite(code)) continue;
    if (code === 0) Object.assign(attributes, initial());
    else if (code === 1) attributes.bold = true;
    else if (code === 2) attributes.dim = true;
    else if (code === 3) attributes.italic = true;
    else if (code === 4) attributes.underline = true;
    else if (code === 7) attributes.inverse = true;
    else if (code === 9) attributes.strike = true;
    else if (code === 22) attributes.bold = attributes.dim = false;
    else if (code === 23) attributes.italic = false;
    else if (code === 24) attributes.underline = false;
    else if (code === 27) attributes.inverse = false;
    else if (code === 29) attributes.strike = false;
    else if (code >= 30 && code <= 37) attributes.fg = BASE_16[code - 30];
    else if (code >= 40 && code <= 47) attributes.bg = BASE_16[code - 40];
    else if (code >= 90 && code <= 97) attributes.fg = BASE_16[code - 90 + 8];
    else if (code >= 100 && code <= 107) attributes.bg = BASE_16[code - 100 + 8];
    else if (code === 39) attributes.fg = undefined;
    else if (code === 49) attributes.bg = undefined;
    else if (code === 38 || code === 48) {
      const kind = Number(codes[i + 1]);
      const target: "fg" | "bg" = code === 38 ? "fg" : "bg";
      if (kind === 5) {
        attributes[target] = xterm256(Number(codes[i + 2]));
        i += 2;
      } else if (kind === 2) {
        attributes[target] = hex(Number(codes[i + 2]), Number(codes[i + 3]), Number(codes[i + 4]));
        i += 4;
      }
    }
  }
}

export function parseSgrRichTextLines(text: string): RichTextSpan[][] {
  const attributes = initial();
  return text.split("\n").map((line) => {
    const spans: RichTextSpan[] = [];
    let cursor = 0;
    SGR_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SGR_PATTERN.exec(line)) !== null) {
      if (match.index > cursor) spans.push(spanOf(line.slice(cursor, match.index), attributes));
      applyParams(attributes, match[1] ?? "");
      cursor = match.index + match[0].length;
    }
    if (cursor < line.length) spans.push(spanOf(line.slice(cursor), attributes));
    return spans;
  });
}

export function richTextLineText(spans: readonly RichTextSpan[]): string {
  return spans.map((span) => span.text).join("");
}

export function richTextText(lines: readonly (readonly RichTextSpan[])[]): string {
  return lines.map(richTextLineText).join("\n");
}

export function sliceRichTextSpans(spans: readonly RichTextSpan[], start: number, end: number): RichTextSpan[] {
  const next: RichTextSpan[] = [];
  let cursor = 0;
  for (const span of spans) {
    const spanStart = cursor;
    const spanEnd = spanStart + span.text.length;
    cursor = spanEnd;
    if (spanEnd <= start || spanStart >= end) continue;
    const text = span.text.slice(Math.max(0, start - spanStart), Math.max(0, end - spanStart));
    if (text) next.push({ ...span, text });
  }
  return next;
}
