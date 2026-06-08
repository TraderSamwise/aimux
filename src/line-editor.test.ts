import { describe, expect, it } from "vitest";

import { applyLineEdit, createLineState, renderLineWindow } from "./line-editor.js";
import type { KeyEvent } from "./key-parser.js";

function key(partial: Partial<KeyEvent>): KeyEvent {
  return { char: "", name: "", shift: false, ctrl: false, alt: false, raw: "", ...partial };
}

const char = (c: string) => key({ char: c });
const named = (name: string, extra: Partial<KeyEvent> = {}) => key({ name, ...extra });
const ctrl = (name: string) => key({ name, ctrl: true });

function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

describe("line editor", () => {
  it("starts with the cursor at the end of the initial text", () => {
    const s = createLineState("hello");
    expect(s).toEqual({ text: "hello", cursor: 5 });
  });

  it("inserts characters at the cursor", () => {
    const s = createLineState("hi");
    s.cursor = 1;
    expect(applyLineEdit(s, char("X"))).toBe(true);
    expect(s).toEqual({ text: "hXi", cursor: 2 });
  });

  it("moves left/right within bounds", () => {
    const s = createLineState("ab");
    applyLineEdit(s, named("left"));
    expect(s.cursor).toBe(1);
    applyLineEdit(s, named("left"));
    applyLineEdit(s, named("left")); // clamped at 0
    expect(s.cursor).toBe(0);
    applyLineEdit(s, named("right"));
    applyLineEdit(s, named("right"));
    applyLineEdit(s, named("right")); // clamped at length
    expect(s.cursor).toBe(2);
  });

  it("supports home/end and ctrl+a/ctrl+e", () => {
    const s = createLineState("hello");
    applyLineEdit(s, named("home"));
    expect(s.cursor).toBe(0);
    applyLineEdit(s, named("end"));
    expect(s.cursor).toBe(5);
    applyLineEdit(s, ctrl("a"));
    expect(s.cursor).toBe(0);
    applyLineEdit(s, ctrl("e"));
    expect(s.cursor).toBe(5);
  });

  it("backspaces before the cursor and is a no-op at start", () => {
    const s = createLineState("abc");
    s.cursor = 2;
    applyLineEdit(s, named("backspace"));
    expect(s).toEqual({ text: "ac", cursor: 1 });
    s.cursor = 0;
    expect(applyLineEdit(s, named("backspace"))).toBe(true);
    expect(s).toEqual({ text: "ac", cursor: 0 });
  });

  it("deletes at the cursor and is a no-op at end", () => {
    const s = createLineState("abc");
    s.cursor = 1;
    applyLineEdit(s, named("delete"));
    expect(s).toEqual({ text: "ac", cursor: 1 });
    s.cursor = 2;
    applyLineEdit(s, named("delete"));
    expect(s).toEqual({ text: "ac", cursor: 2 });
  });

  it("ctrl+u kills to start, ctrl+k kills to end, ctrl+w deletes a word", () => {
    const u = createLineState("hello world");
    u.cursor = 6;
    applyLineEdit(u, ctrl("u"));
    expect(u).toEqual({ text: "world", cursor: 0 });

    const k = createLineState("hello world");
    k.cursor = 5;
    applyLineEdit(k, ctrl("k"));
    expect(k).toEqual({ text: "hello", cursor: 5 });

    const w = createLineState("foo bar baz");
    w.cursor = 11;
    applyLineEdit(w, ctrl("w"));
    expect(w).toEqual({ text: "foo bar ", cursor: 8 });
  });

  it("inserts pasted text and collapses newlines to spaces", () => {
    const s = createLineState("");
    applyLineEdit(s, key({ name: "paste", char: "a\nb" }));
    expect(s).toEqual({ text: "a b", cursor: 3 });
  });

  it("does not consume enter/escape/tab", () => {
    const s = createLineState("x");
    expect(applyLineEdit(s, named("enter"))).toBe(false);
    expect(applyLineEdit(s, named("escape"))).toBe(false);
    expect(applyLineEdit(s, named("tab"))).toBe(false);
    expect(s).toEqual({ text: "x", cursor: 1 });
  });

  it("renders a reverse-video cursor over the character at the cursor", () => {
    const s = createLineState("abc");
    s.cursor = 1;
    expect(renderLineWindow(s, 80)).toBe("a\x1b[7mb\x1b[27mc");
  });

  it("renders a trailing highlighted cell when the cursor is past the end", () => {
    const s = createLineState("ab");
    expect(renderLineWindow(s, 80)).toBe("ab\x1b[7m \x1b[27m");
  });

  it("horizontally scrolls so the cursor stays visible within maxWidth", () => {
    const s = createLineState("0123456789");
    s.cursor = 9;
    const out = renderLineWindow(s, 5);
    expect(visibleLength(out)).toBeLessThanOrEqual(5);
    // cursor char (9) must be present and highlighted
    expect(out).toContain("\x1b[7m9\x1b[27m");
  });
});
