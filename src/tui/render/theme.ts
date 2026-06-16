import { stripAnsi, truncateAnsi } from "./text.js";

const RESET = "\x1b[0m";

/**
 * Semantic foreground color tokens. Surfaces reference a meaning (e.g. `accent`,
 * `work`) instead of a raw escape code, so the whole TUI restyles from one place.
 */
export type Tone =
  | "text"
  | "muted"
  | "strong"
  | "accent"
  | "work"
  | "attn"
  | "done"
  | "danger"
  | "blocked"
  | "info"
  | "idle";

const TONE_SGR: Record<Tone, string> = {
  text: "",
  muted: "\x1b[2m",
  strong: "\x1b[1m",
  accent: "\x1b[1;33m",
  work: "\x1b[36m",
  attn: "\x1b[1;33m",
  done: "\x1b[32m",
  danger: "\x1b[31m",
  blocked: "\x1b[35m",
  info: "\x1b[34m",
  idle: "\x1b[2;32m",
};

export function style(text: string, tone: Tone): string {
  const sgr = TONE_SGR[tone];
  return sgr ? `${sgr}${text}${RESET}` : text;
}

/** Visible width of a string, ignoring ANSI escape sequences. */
export function visibleWidth(text: string): number {
  return stripAnsi(text).length;
}

/** Pad a (possibly styled) string to an exact visible width, truncating if over. */
export function padVisible(text: string, width: number): string {
  const current = visibleWidth(text);
  if (current === width) return text;
  if (current > width) return truncateAnsi(text, width);
  return `${text}${" ".repeat(width - current)}`;
}

export interface Column {
  content: string;
  width: number;
}

/** Join styled cells onto a fixed grid; each cell is padded/truncated to its width. */
export function cols(columns: Column[]): string {
  return columns.map((column) => padVisible(column.content, column.width)).join("");
}

/**
 * A status pill: character-exact reverse-video chip (` LABEL `). Reverse video keeps
 * it portable across terminals; visible width is always `label.length + 2`.
 */
export function pill(label: string, tone: Tone): string {
  const base = TONE_SGR[tone];
  const sgr = base ? base.replace(/m$/, ";7m") : "\x1b[7m";
  return `${sgr} ${label} ${RESET}`;
}

export type ChipTone = "info" | "work" | "attn" | "muted" | "danger";

const CHIP_FG: Record<ChipTone, number> = {
  info: 117,
  work: 80,
  attn: 179,
  muted: 245,
  danger: 174,
};

/** A soft count/metadata chip on a 256-color background (` label `). */
export function chip(label: string, tone: ChipTone = "info"): string {
  return `\x1b[48;5;236;38;5;${CHIP_FG[tone]}m ${label} ${RESET}`;
}

/** A keyboard keycap for footer/help bars (` key `). */
export function keycap(key: string): string {
  return `\x1b[48;5;238;38;5;253m ${key} ${RESET}`;
}

/** A footer/help hint: a keycap plus a muted label (label optional). */
export function keycapHint(key: string, label = ""): string {
  return label ? `${keycap(key)} ${style(label, "muted")}` : keycap(key);
}

// Style one "[key] label" or "key label" help group into a keycap + muted label.
function styleHintGroup(group: string): string {
  const bracket = group.match(/^\[(.+?)\]\s*(.*)$/);
  if (bracket) return keycapHint(bracket[1], bracket[2]);
  const splitAt = group.indexOf(" ");
  if (splitAt < 0) return keycap(group);
  return keycapHint(group.slice(0, splitAt), group.slice(splitAt + 1));
}

/** Style a help/footer line ("[a] x  [b] y" or "a x  b y") into joined keycap hints. */
export function keycapHints(line: string): string {
  return line
    .trim()
    .split(/\s{2,}/)
    .filter(Boolean)
    .map(styleHintGroup)
    .join("  ");
}

/** Like keycapHints, but wraps the keycap groups to `width` visible columns. */
export function keycapHintLines(line: string, width: number): string[] {
  const groups = line
    .trim()
    .split(/\s{2,}/)
    .filter(Boolean)
    .map(styleHintGroup);
  const lines: string[] = [];
  let current = "";
  for (const group of groups) {
    const next = current ? `${current}  ${group}` : group;
    if (visibleWidth(next) <= width) {
      current = next;
    } else {
      if (current) lines.push(current);
      current = group;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export type BandTone = "info" | "danger";

const BAND_SGR: Record<BandTone, string> = {
  info: "\x1b[1;48;5;24;38;5;195m",
  danger: "\x1b[1;48;5;52;38;5;224m",
};

/**
 * A modal title band: a tinted full-width header bar (` LABEL …`) filling `width`
 * visible columns, used for the window-chrome title row of overlay dialogs. The
 * background tint runs the whole width (leading gutter through trailing padding).
 */
export function modalBand(label: string, tone: BandTone, width: number): string {
  return `${BAND_SGR[tone]}${padVisible(` ${label}`, Math.max(0, width))}${RESET}`;
}

/** Presentation-level status kinds (distinct from runtime SessionStatus). */
export type StatusKind =
  | "working"
  | "ready"
  | "idle"
  | "offline"
  | "needs"
  | "error"
  | "done"
  | "blocked"
  | "service"
  | "serviceOff";

const STATE_GLYPH: Record<StatusKind, string> = {
  working: "●",
  ready: "●",
  idle: "●",
  offline: "○",
  needs: "◉",
  error: "●",
  done: "●",
  blocked: "●",
  service: "◆",
  serviceOff: "◇",
};

const STATE_TONE: Record<StatusKind, Tone> = {
  working: "work",
  ready: "muted",
  idle: "idle",
  offline: "muted",
  needs: "attn",
  error: "danger",
  done: "done",
  blocked: "blocked",
  service: "done",
  serviceOff: "muted",
};

export function statusDot(kind: StatusKind): string {
  return style(STATE_GLYPH[kind], STATE_TONE[kind]);
}

export function statusTone(kind: StatusKind): Tone {
  return STATE_TONE[kind];
}

// tmux format-code equivalents of the color tokens, for surfaces rendered via
// `#[fg=...]` directives (the tmux statusline) rather than ANSI.
const TMUX_COLOR: Partial<Record<Tone, string>> = {
  muted: "colour244",
  accent: "yellow",
  work: "cyan",
  attn: "yellow",
  done: "green",
  danger: "red",
  blocked: "magenta",
  info: "cyan",
  idle: "green",
};

export function tmuxStyle(text: string, tone: Tone): string {
  const color = TMUX_COLOR[tone];
  return color ? `#[fg=${color}]${text}#[default]` : text;
}

export function tmuxInvert(text: string, tone: Tone): string {
  const color = TMUX_COLOR[tone] ?? "white";
  return `#[fg=black,bg=${color}]${text}#[default]`;
}

export function divider(width: number, tone: Tone = "muted"): string {
  return style("─".repeat(Math.max(0, width)), tone);
}

export interface CardSpec {
  /** Border tint (e.g. aggregate urgency of the card's contents). */
  tone: Tone;
  /** Pre-styled title shown in the top rule. */
  title: string;
  /** Pre-styled summary, right-aligned in the top rule. */
  summary?: string;
  /** Pre-styled body rows. */
  rows?: string[];
  /** Total width including borders. */
  width: number;
}

/**
 * A rounded, tinted card: titled top rule with optional right-aligned summary, padded
 * body rows, and a bottom rule. Every returned line has the same visible width so the
 * right border stays aligned. Title/summary/rows are passed pre-styled.
 */
export function card({ tone, title, summary, rows = [], width }: CardSpec): string[] {
  const w = Math.max(8, width);
  const inner = w - 4;
  const border = (segment: string): string => style(segment, tone);
  const lines: string[] = [];

  // Top rule: "╭ " title " " ───… [" " summary " "] "╮". Budget so the closing "╮"
  // and a minimum 2-dash run are never truncated away when content overflows.
  const frame = 2 + 1 + 2 + 1;
  let summaryText = summary ?? "";
  let summaryCost = summaryText ? 1 + visibleWidth(summaryText) + 1 : 0;
  let titleMax = w - frame - summaryCost;
  if (titleMax < 1 && summaryText) {
    summaryText = "";
    summaryCost = 0;
    titleMax = w - frame;
  }
  const fittedTitle = visibleWidth(title) > titleMax ? truncateAnsi(title, Math.max(0, titleMax)) : title;
  const titleSep = visibleWidth(fittedTitle) > 0 ? " " : "";
  const used = 2 + visibleWidth(fittedTitle) + titleSep.length + summaryCost + 1;
  const dashes = Math.max(2, w - used);
  let top = `${border("╭ ")}${fittedTitle}${titleSep}${border("─".repeat(dashes))}`;
  if (summaryText) top += ` ${summaryText} `;
  top += border("╮");
  lines.push(padVisible(top, w));

  for (const row of rows) {
    lines.push(`${border("│ ")}${padVisible(row, inner)}${border(" │")}`);
  }

  lines.push(`${border("╰")}${border("─".repeat(w - 2))}${border("╯")}`);
  return lines;
}
