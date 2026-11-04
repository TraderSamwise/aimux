import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ansiLineText } from "./ansi";
import {
  MIN_TERMINAL_DIVIDER_WIDTH,
  TERMINAL_CHAR_WIDTH,
  TERMINAL_COLUMN_SAFETY,
  TERMINAL_CONTENT_PADDING,
  TERMINAL_DIVIDER_FALLBACK,
  terminalDividerColumns,
} from "./terminal-columns";
import { formatTerminalOutputForDisplay } from "./terminal-output";

const SCREEN = readFileSync(
  join(__dirname, "..", "components", "screens", "AgentChatScreen.tsx"),
  "utf8",
);

/** Claude Code's prompt box, as captured from sam-mini: 199 columns wide. */
const PROMPT_BOX = [
  "✻ Baked for 8s · done 11:11 AM",
  "",
  `${"─".repeat(190)} deaws2 ─`,
  "❯",
  "─".repeat(199),
].join("\n");

describe("a rule never outgrows its pane", () => {
  it("fits a 199-column prompt box into a narrow pane", () => {
    // The bug: a 60-column pane rendered this 199-column border across three
    // rows, and the box has two borders, so one input line was framed by six
    // rows of line art.
    const paneWidth = 460; // about 60 columns at this font
    const columns = terminalDividerColumns(paneWidth, 72);
    const rendered = formatTerminalOutputForDisplay(PROMPT_BOX, { dividerWidth: columns })
      .map(ansiLineText)
      .map((line) => line.trim().length);

    expect(Math.max(...rendered)).toBeLessThanOrEqual(columns);
    // And it must still fit the pane it was measured against.
    expect(columns * TERMINAL_CHAR_WIDTH).toBeLessThan(paneWidth - TERMINAL_CONTENT_PADDING);
  });

  it("keeps both borders -- they are not one wrapped rule", () => {
    // The earlier attempt at this collapsed consecutive rules on the theory
    // that they were one rule wrapped. They are the top and bottom of the
    // prompt box, and collapsing them eats the bottom one.
    const lines = formatTerminalOutputForDisplay(PROMPT_BOX, { dividerWidth: 48 })
      .map(ansiLineText)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("─"));

    expect(lines.length).toBe(2);
  });

  it("gives columns away rather than reaching the edge", () => {
    // Truncating early is invisible on a horizontal line. Truncating late
    // wraps it, which is the whole bug, so the costs are not symmetric.
    const paneWidth = 460;
    const exact = Math.floor((paneWidth - TERMINAL_CONTENT_PADDING) / TERMINAL_CHAR_WIDTH);
    expect(terminalDividerColumns(paneWidth, 72)).toBe(exact - TERMINAL_COLUMN_SAFETY);
    expect(TERMINAL_COLUMN_SAFETY).toBeGreaterThanOrEqual(4);
  });

  it("falls back before layout has measured anything", () => {
    // Zero would truncate every rule to nothing on the first render.
    expect(terminalDividerColumns(0, TERMINAL_DIVIDER_FALLBACK)).toBe(TERMINAL_DIVIDER_FALLBACK);
    expect(terminalDividerColumns(Number.NaN, 48)).toBe(48);
    expect(terminalDividerColumns(-10, 48)).toBe(48);
  });

  it("counts every inset between the pane frame and the glyphs", () => {
    // Asserted against the SCREEN, not restated as arithmetic: writing
    // `toBe(24 + 24 + 2)` passes happily after someone changes the padding
    // in the JSX, which is the only place that can make it wrong.
    expect(SCREEN).toContain("paddingHorizontal: 12");
    expect(SCREEN).toContain("rounded-lg border border-border bg-card/80 px-3 py-2");
    // 12*2 scroll content + 12*2 card + 1*2 border.
    expect(TERMINAL_CONTENT_PADDING).toBe(50);
  });

  it("keeps real slack after the insets are paid", () => {
    // The point of the safety margin is that it survives contact with the
    // pane. At 460px the rule must leave room for the scrollbar too.
    const columns = terminalDividerColumns(460, 48);
    const glyphWidth = columns * TERMINAL_CHAR_WIDTH;
    const usable = 460 - TERMINAL_CONTENT_PADDING;
    expect(usable - glyphWidth).toBeGreaterThanOrEqual(
      TERMINAL_COLUMN_SAFETY * TERMINAL_CHAR_WIDTH,
    );
  });

  it("stops shrinking before a rule stops reading as one", () => {
    expect(terminalDividerColumns(30, 72)).toBe(MIN_TERMINAL_DIVIDER_WIDTH);
  });
});

describe("the pane is wired to its own width", () => {
  it("truncates to the measured pane, not twice a chat bubble", () => {
    // The old value was `Math.max(48, dividerWidth * 2)` -- twice the width
    // of a CHAT BUBBLE, capped at 72, so at most 144 columns, a number with
    // nothing to do with this pane. At 144 a 199-column border still wrapped.
    expect(SCREEN).toContain("event.nativeEvent.layout.width,");
    expect(SCREEN).toContain("paneColumns ?? TERMINAL_DIVIDER_FALLBACK");
    expect(SCREEN).not.toContain("Math.max(48, dividerWidth * 2)");
  });

  it("measures the pane where it already measures its height", () => {
    expect(SCREEN).toContain("setPaneColumns(");
  });

  it("commits state per COLUMN, not per pixel", () => {
    // One column is 7.2px, so a pixel-quantised guard commits up to seven
    // times per column during a resize, and every commit re-parses the whole
    // output tail.
    expect(SCREEN).toContain("const measuredColumns = terminalDividerColumns(");
    expect(SCREEN).not.toContain("Math.abs(current - measured) < 1");
  });

  it("pins the terminal font against the OS text scale", () => {
    // `layout.width` is in dp but a scaled glyph is wider, so at Larger Text
    // the computed column count is ~30% too many and every rule wraps again.
    //
    // BOTH nodes: the line and the span inside it. Asserting "contains" was
    // satisfied by either one, so dropping it from the span still passed.
    const pinned = SCREEN.match(/allowFontScaling=\{false\}/g) ?? [];
    expect(pinned.length).toBe(2);
  });
});
