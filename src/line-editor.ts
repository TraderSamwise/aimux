import type { KeyEvent } from "./key-parser.js";

/** A single-line text input with a cursor position (0..text.length). */
export interface LineState {
  text: string;
  cursor: number;
}

export function createLineState(initial = ""): LineState {
  return { text: initial, cursor: initial.length };
}

function clampCursor(state: LineState): void {
  state.cursor = Math.max(0, Math.min(state.cursor, state.text.length));
}

function deleteRange(state: LineState, start: number, end: number): void {
  state.text = state.text.slice(0, start) + state.text.slice(end);
  state.cursor = start;
}

function wordStart(text: string, from: number): number {
  let i = from;
  while (i > 0 && /\s/.test(text[i - 1])) i--;
  while (i > 0 && !/\s/.test(text[i - 1])) i--;
  return i;
}

/**
 * Apply an editing/navigation key to the line state in place.
 * Returns true if the event was consumed, false if the caller should handle it
 * (e.g. enter, escape, tab).
 */
export function applyLineEdit(state: LineState, event: KeyEvent): boolean {
  clampCursor(state);
  const { name } = event;

  if (event.ctrl && !event.alt) {
    switch (name) {
      case "a":
        state.cursor = 0;
        return true;
      case "e":
        state.cursor = state.text.length;
        return true;
      case "u":
        deleteRange(state, 0, state.cursor);
        return true;
      case "k":
        state.text = state.text.slice(0, state.cursor);
        return true;
      case "w":
        deleteRange(state, wordStart(state.text, state.cursor), state.cursor);
        return true;
      default:
        return false;
    }
  }

  switch (name) {
    case "left":
      if (state.cursor > 0) state.cursor--;
      return true;
    case "right":
      if (state.cursor < state.text.length) state.cursor++;
      return true;
    case "home":
      state.cursor = 0;
      return true;
    case "end":
      state.cursor = state.text.length;
      return true;
    case "backspace":
      if (state.cursor > 0) deleteRange(state, state.cursor - 1, state.cursor);
      return true;
    case "delete":
      if (state.cursor < state.text.length) deleteRange(state, state.cursor, state.cursor + 1);
      return true;
    default:
      break;
  }

  const isPaste = name === "paste";
  const isPrintable = name === "" && event.char.length > 0 && !event.ctrl && !event.alt;
  if (isPaste || isPrintable) {
    const insert = event.char.replace(/[\r\n]+/g, " ");
    state.text = state.text.slice(0, state.cursor) + insert + state.text.slice(state.cursor);
    state.cursor += insert.length;
    return true;
  }

  return false;
}

/**
 * Render the line as a display string with a reverse-video cursor, horizontally
 * scrolled so the cursor stays visible within maxWidth columns. The returned
 * string has at most maxWidth visible columns (ANSI codes add no width).
 */
export function renderLineWindow(state: LineState, maxWidth: number): string {
  const width = Math.max(1, maxWidth);
  const cursor = Math.max(0, Math.min(state.cursor, state.text.length));
  // Include a trailing cell only when the cursor sits past the last character.
  const base = cursor >= state.text.length ? `${state.text} ` : state.text;
  const chars = [...base];
  let start = 0;
  if (cursor >= width) start = cursor - width + 1;
  const end = Math.min(chars.length, start + width);
  start = Math.max(0, end - width);

  let out = "";
  for (let i = start; i < end; i++) {
    out += i === cursor ? `\x1b[7m${chars[i]}\x1b[27m` : chars[i];
  }
  return out;
}
