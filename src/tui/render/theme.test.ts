import { describe, expect, it } from "vitest";
import { stripAnsi } from "./text.js";
import {
  card,
  chip,
  cols,
  divider,
  footerHints,
  keycap,
  keycapHint,
  keycapHintLines,
  keycapHints,
  padVisible,
  recede,
  renderFooterHints,
  pill,
  statusDot,
  statusTone,
  style,
  tmuxInvert,
  tmuxStyle,
  visibleWidth,
} from "./theme.js";

describe("theme tokens", () => {
  it("style wraps in SGR + reset and passes through the text tone", () => {
    expect(style("hi", "danger")).toBe("\x1b[31mhi\x1b[0m");
    expect(style("hi", "accent")).toBe("\x1b[1;33mhi\x1b[0m");
    expect(style("hi", "text")).toBe("hi");
  });

  it("statusDot maps a kind to a colored glyph", () => {
    expect(stripAnsi(statusDot("working"))).toBe("●");
    expect(stripAnsi(statusDot("offline"))).toBe("○");
    expect(stripAnsi(statusDot("needs"))).toBe("◉");
    expect(stripAnsi(statusDot("service"))).toBe("◆");
    expect(statusDot("error")).toContain("\x1b[31m");
  });

  it("gives ready a distinct online color, not the offline gray", () => {
    expect(statusTone("ready")).toBe("ready");
    expect(statusTone("ready")).not.toBe(statusTone("offline"));
    // ready paints sky blue (256-color 75); offline stays dim gray (\x1b[2m).
    expect(style("x", "ready")).toContain("38;5;75");
    expect(statusDot("ready")).toContain("38;5;75");
    expect(statusDot("offline")).toContain("\x1b[2m");
    expect(statusDot("ready")).not.toContain("\x1b[2m");
  });
});

describe("theme primitives", () => {
  it("computes visible width ignoring escape codes", () => {
    expect(visibleWidth(style("hello", "work"))).toBe(5);
    expect(visibleWidth(pill("WORKING", "work"))).toBe("WORKING".length + 2);
    expect(visibleWidth(chip("22 unseen"))).toBe("22 unseen".length + 2);
    expect(visibleWidth(keycap("q"))).toBe(3);
  });

  it("renders pills as character-exact reverse video", () => {
    const p = pill("OK", "done");
    expect(stripAnsi(p)).toBe(" OK ");
    expect(p).toContain(";7m");
    expect(pill("X", "text")).toBe("\x1b[7m X \x1b[0m");
  });

  it("pads to an exact width and truncates while preserving escapes", () => {
    expect(visibleWidth(padVisible(style("ab", "work"), 6))).toBe(6);
    const truncated = padVisible(style("abcdef", "work"), 4);
    expect(visibleWidth(truncated)).toBe(4);
    expect(truncated).toContain("\x1b[");
  });

  it("aligns mixed styled and plain content onto a grid", () => {
    const line = cols([
      { content: statusDot("working"), width: 2 },
      { content: style("codex", "strong"), width: 10 },
      { content: pill("WORKING", "work"), width: 14 },
    ]);
    expect(visibleWidth(line)).toBe(26);
    const plain = stripAnsi(line);
    expect(plain.startsWith("● codex")).toBe(true);
    expect(plain).toContain("WORKING");
  });

  it("renders a divider of exact width", () => {
    expect(stripAnsi(divider(5))).toBe("─────");
  });

  it("renders keycap hints as a keycap plus muted label", () => {
    expect(stripAnsi(keycapHint("q", "quit"))).toBe(" q  quit");
    expect(stripAnsi(keycapHint("Esc"))).toBe(" Esc ");
    expect(keycapHint("q", "quit")).toContain(keycap("q"));
  });

  it("tints destructive keycaps red and uses the standard glyph otherwise", () => {
    expect(keycap("n")).toContain("38;5;255");
    expect(keycap("x", "danger")).toContain("38;5;203");
    expect(keycapHint("x", "kill", "danger")).toContain(keycap("x", "danger"));
  });

  it("styles a footer line into keycap groups, supporting [key] and key forms", () => {
    const rendered = keycapHints("[↑↓] select  q quit");
    expect(stripAnsi(rendered)).toBe(" ↑↓  select   q  quit");
    expect(rendered).toContain(keycap("↑↓"));
    expect(rendered).toContain(keycap("q"));
  });

  it("styles a footer line box-free (bold glyph keys, no pill background)", () => {
    const rendered = footerHints("[↑↓] select  q quit");
    expect(stripAnsi(rendered)).toBe("↑↓ select  q quit");
    expect(rendered).not.toContain("48;5;"); // no keycap background fill
    expect(rendered).toContain("\x1b[1;38;5;255m↑↓"); // bold key glyph
  });

  it("wraps keycap hint groups to a width budget across lines", () => {
    const lines = keycapHintLines("[a] alpha  [b] bravo  [c] charlie", 14);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(14);
  });
});

describe("recede", () => {
  it("faint mode prepends the gray faint lead and re-injects it after embedded resets", () => {
    expect(recede("plain")).toBe("\x1b[2;38;5;240mplain\x1b[0m");
    // A pre-styled span keeps its color but gains faint, and the lead resumes after the reset.
    expect(recede(`${style("hi", "danger")}bye`)).toBe("\x1b[2;38;5;240m\x1b[31mhi\x1b[0m\x1b[2;38;5;240mbye\x1b[0m");
  });

  it("faint mode also matches the shorthand reset \\x1b[m", () => {
    expect(recede("a\x1b[mb")).toBe("\x1b[2;38;5;240ma\x1b[0m\x1b[2;38;5;240mb\x1b[0m");
  });

  it("faint mode resumes after reset-led sequences, re-emitting their params", () => {
    // A reset-led form clears faint, so re-apply the lead AND the params (here bold) after it.
    expect(recede("x\x1b[0;1my")).toBe("\x1b[2;38;5;240mx\x1b[0m\x1b[2;38;5;240m\x1b[1my\x1b[0m");
    // A non-reset color (\x1b[31m) is left intact so its color still shows, dimmed.
    expect(recede("\x1b[31mhi")).toBe("\x1b[2;38;5;240m\x1b[31mhi\x1b[0m");
  });

  it("faint mode keeps a reset-led color (e.g. \\x1b[0;31m) so backdrops stay colored", () => {
    const out = recede("\x1b[0;31mred");
    expect(out).toContain("\x1b[31m"); // the red survives the reset, just faint-dimmed
    expect(out).toContain("\x1b[2;38;5;240m"); // and the faint lead is reapplied after the reset
    expect(stripAnsi(out)).toBe("red");
  });

  it("flatten modes strip color and re-emit as a single 256-color gray", () => {
    expect(recede(style("hi", "danger"), "soft")).toBe("\x1b[38;5;250mhi\x1b[0m");
    expect(recede(style("hi", "danger"), "deep")).toBe("\x1b[38;5;240mhi\x1b[0m");
  });

  it("preserves visible width when flattening multicolor content", () => {
    const colored = `${style("ab", "work")}${style("cd", "accent")}`;
    expect(visibleWidth(colored)).toBe(4);
    expect(visibleWidth(recede(colored, "deep"))).toBe(4);
    expect(stripAnsi(recede(colored, "deep"))).toBe("abcd");
  });

  it("returns an empty string unchanged in every mode", () => {
    expect(recede("")).toBe("");
    expect(recede("", "soft")).toBe("");
    expect(recede("", "deep")).toBe("");
  });
});

describe("renderFooterHints", () => {
  it("renders all hints on one line when they fit", () => {
    const [line, ...rest] = renderFooterHints(
      [
        ["u", "attention"],
        ["n", "agent"],
        ["q", "quit"],
      ],
      200,
    );
    expect(rest).toHaveLength(0);
    const plain = stripAnsi(line);
    expect(plain).toContain("attention");
    expect(plain).toContain("agent");
    expect(plain).toContain("quit");
  });

  it("tints destructive hints red", () => {
    const [line] = renderFooterHints([["x", "kill", "danger"]], 200);
    expect(line).toContain("38;5;203");
  });

  it("wraps a long list to the width budget, showing every hint", () => {
    const hints: Array<[string, string]> = [
      ["a", "alpha"],
      ["b", "bravo"],
      ["c", "charlie"],
      ["d", "delta"],
    ];
    const lines = renderFooterHints(hints, 16);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(16);
    const all = lines.map(stripAnsi).join(" ");
    for (const [, label] of hints) expect(all).toContain(label);
  });
});

describe("card", () => {
  it("produces equal-width lines with an aligned right border", () => {
    const lines = card({
      tone: "accent",
      title: style("[1] main", "strong"),
      summary: style("1 offline", "muted"),
      rows: [style("agent row", "text")],
      width: 40,
    });
    for (const line of lines) expect(visibleWidth(line)).toBe(40);
    const top = stripAnsi(lines[0]);
    expect(top.startsWith("╭")).toBe(true);
    expect(top.endsWith("╮")).toBe(true);
    expect(top).toContain("[1] main");
    expect(top).toContain("1 offline");
    const body = stripAnsi(lines[1]);
    expect(body.startsWith("│ ")).toBe(true);
    expect(body.endsWith(" │")).toBe(true);
    expect(stripAnsi(lines[lines.length - 1])).toBe(`╰${"─".repeat(38)}╯`);
  });

  it("renders a titles-only card (no body rows) as two lines", () => {
    const lines = card({
      tone: "muted",
      title: style("[2] wt", "accent"),
      summary: style("no agents", "muted"),
      width: 30,
    });
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(visibleWidth(line)).toBe(30);
  });

  it("keeps the closing border when title and summary overflow the width", () => {
    const lines = card({
      tone: "danger",
      title: style("a very very long worktree title that overflows", "strong"),
      summary: style("1 working", "work"),
      width: 24,
    });
    for (const line of lines) expect(visibleWidth(line)).toBe(24);
    expect(stripAnsi(lines[0]).endsWith("╮")).toBe(true);
  });

  it("clamps tiny widths and still closes the card", () => {
    const lines = card({ tone: "muted", title: style("x", "text"), width: 3 });
    for (const line of lines) expect(visibleWidth(line)).toBe(8);
    expect(stripAnsi(lines[0]).startsWith("╭")).toBe(true);
    expect(stripAnsi(lines[0]).endsWith("╮")).toBe(true);
  });
});

describe("theme primitive branches", () => {
  it("styles every tone and status kind without breaking width", () => {
    for (const tone of [
      "text",
      "muted",
      "strong",
      "accent",
      "work",
      "attn",
      "done",
      "danger",
      "blocked",
      "info",
      "ready",
      "idle",
    ] as const) {
      expect(visibleWidth(style("abc", tone))).toBe(3);
    }
    for (const kind of [
      "working",
      "ready",
      "idle",
      "offline",
      "needs",
      "error",
      "done",
      "blocked",
      "service",
      "serviceOff",
    ] as const) {
      expect(visibleWidth(statusDot(kind))).toBe(1);
    }
  });

  it("renders chips and keycaps for every tone at the expected width", () => {
    for (const tone of ["info", "work", "attn", "muted", "danger"] as const) {
      expect(visibleWidth(chip("9 unseen", tone))).toBe("9 unseen".length + 2);
    }
    expect(visibleWidth(keycap("⏎"))).toBe(3);
  });

  it("pads shorter content up to the target width", () => {
    expect(stripAnsi(padVisible("ab", 5))).toBe("ab   ");
    expect(stripAnsi(divider(0))).toBe("");
  });
});

describe("tmux tokens", () => {
  it("wraps fg color directives by tone", () => {
    expect(tmuxStyle("x", "work")).toBe("#[fg=cyan]x#[default]");
    expect(tmuxStyle("x", "done")).toBe("#[fg=green]x#[default]");
    expect(tmuxStyle("x", "attn")).toBe("#[fg=yellow]x#[default]");
    expect(tmuxStyle("x", "danger")).toBe("#[fg=red]x#[default]");
  });

  it("passes text through for tones without a tmux color", () => {
    expect(tmuxStyle("x", "text")).toBe("x");
    expect(tmuxStyle("x", "strong")).toBe("x");
  });

  it("renders inverse highlights", () => {
    expect(tmuxInvert(" x ", "attn")).toBe("#[fg=black,bg=yellow] x #[default]");
    expect(tmuxInvert(" x ", "work")).toBe("#[fg=black,bg=cyan] x #[default]");
  });
});
