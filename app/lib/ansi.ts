/**
 * SGR escapes from a tmux `-e` capture, turned into styled runs.
 *
 * Only `ESC [ … m` is interpreted; anything else that reaches us is dropped
 * rather than rendered, so a pane cannot push stray control bytes into the view.
 *
 * The 16 base colours are remapped and everything else is passed through. Base
 * colours name slots in *a* palette rather than actual colours — every terminal
 * resolves them differently — so honouring them literally would paint the pane
 * in whatever xterm decided in 1994. A 256-colour or truecolor escape already
 * carries the colour the tool chose, and is left alone.
 */

export interface AnsiStyle {
  color?: string;
  backgroundColor?: string;
  fontWeight?: "bold";
  fontStyle?: "italic";
  textDecorationLine?: "underline" | "line-through" | "underline line-through";
  /** Dim, applied as opacity so it composes with any foreground colour. */
  opacity?: number;
}

export interface AnsiSpan {
  text: string;
  style: AnsiStyle;
}

/**
 * Base-16, on a dark ground. Lifted brightness on the dark end: terminals draw
 * "black" against the terminal's own background, and a pane rendered inside a
 * card needs those to stay visible rather than merge with it.
 */
const BASE_16 = [
  "#5c6370", // black — floored so dim text does not vanish into the card
  "#e06c75",
  "#98c379",
  "#d19a66",
  "#61afef",
  "#c678dd",
  "#56b6c2",
  "#abb2bf",
  "#7f848e", // bright black
  "#ff7b86",
  "#b5e08a",
  "#e5c07b",
  "#7cc5ff",
  "#dd93ec",
  "#66d9e2",
  "#ffffff",
] as const;

const SGR_PATTERN = /\x1b\[([0-9;:]*)m/g;
const DIM_OPACITY = 0.6;

/** xterm-256 → hex: 16 base slots, a 6×6×6 cube, then a 24-step gray ramp. */
function xterm256(index: number): string | undefined {
  if (index < 0 || index > 255) return undefined;
  if (index < 16) return BASE_16[index];
  if (index < 232) {
    const offset = index - 16;
    const level = (value: number) => (value === 0 ? 0 : value * 40 + 55);
    const rgb = [
      level(Math.floor(offset / 36)),
      level(Math.floor(offset / 6) % 6),
      level(offset % 6),
    ];
    return hex(rgb[0]!, rgb[1]!, rgb[2]!);
  }
  const gray = (index - 232) * 10 + 8;
  return hex(gray, gray, gray);
}

function hex(r: number, g: number, b: number): string {
  const channel = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

function decoration(underline: boolean, strike: boolean): AnsiStyle["textDecorationLine"] {
  if (underline && strike) return "underline line-through";
  if (underline) return "underline";
  if (strike) return "line-through";
  return undefined;
}

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

function initial(): Attributes {
  // fg/bg are spelled out rather than left off: reset applies this over the live
  // attributes with Object.assign, which cannot clear a key that is not present.
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

function styleOf(attributes: Attributes): AnsiStyle {
  // Inverse swaps the two, and a missing side means "the ground", which the
  // caller owns — so an inverted run with no explicit colour gets neither, and
  // the caller's own foreground/background still read correctly.
  const fg = attributes.inverse ? attributes.bg : attributes.fg;
  const bg = attributes.inverse ? attributes.fg : attributes.bg;
  const style: AnsiStyle = {};
  if (fg) style.color = fg;
  if (bg) style.backgroundColor = bg;
  if (attributes.bold) style.fontWeight = "bold";
  if (attributes.italic) style.fontStyle = "italic";
  if (attributes.dim) style.opacity = DIM_OPACITY;
  const line = decoration(attributes.underline, attributes.strike);
  if (line) style.textDecorationLine = line;
  return style;
}

/**
 * Apply one SGR parameter list, in place.
 *
 * Colon-separated forms (`38:2:r:g:b`) are normalized to semicolons first: both
 * spellings are in the wild, and tmux re-emits whichever the app used.
 */
function applyParams(attributes: Attributes, params: string): void {
  const codes = params.replace(/:/g, ";").split(";");
  for (let i = 0; i < codes.length; i += 1) {
    const code = Number(codes[i] === "" ? 0 : codes[i]);
    if (!Number.isFinite(code)) continue;
    if (code === 0) {
      Object.assign(attributes, initial());
      continue;
    }
    if (code === 1) attributes.bold = true;
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

/**
 * One line of pane text as styled runs.
 *
 * Attributes carry across lines, because tmux emits them where they change, not
 * once per row — so each line is parsed with the state the previous one left.
 */
export function parseAnsiLines(text: string): AnsiSpan[][] {
  const attributes = initial();
  return text.split("\n").map((line) => {
    const spans: AnsiSpan[] = [];
    let cursor = 0;
    SGR_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SGR_PATTERN.exec(line)) !== null) {
      if (match.index > cursor) {
        spans.push({ text: line.slice(cursor, match.index), style: styleOf(attributes) });
      }
      applyParams(attributes, match[1] ?? "");
      cursor = match.index + match[0].length;
    }
    if (cursor < line.length) spans.push({ text: line.slice(cursor), style: styleOf(attributes) });
    return spans;
  });
}

/** The plain text of a parsed line, for callers measuring or matching on it. */
export function ansiLineText(spans: readonly AnsiSpan[]): string {
  return spans.map((span) => span.text).join("");
}
