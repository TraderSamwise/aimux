import { describe, expect, it } from "vitest";
import { renderOverlayBox } from "./box.js";
import { stripAnsi } from "./text.js";

describe("renderOverlayBox", () => {
  it("draws a rounded box with a titled band and separator in the requested tone", () => {
    const out = renderOverlayBox({ title: "Title", body: ["  body line"], cols: 80, rows: 24 });
    const plain = stripAnsi(out);
    expect(plain).toContain("╭");
    expect(plain).toContain("╮");
    expect(plain).toContain("╰");
    expect(plain).toContain("╯");
    expect(plain).toContain("├");
    expect(plain).toContain("┤");
    expect(plain).toContain("│");
    // Title is upper-cased in the band.
    expect(plain).toContain("TITLE");
    expect(plain).toContain("body line");
    expect(out).toContain("\x1b[34m");
  });

  it("uses the danger tone and a warning glyph for the red variant", () => {
    const out = renderOverlayBox({ title: "Danger", body: [], cols: 80, rows: 24, variant: "red" });
    expect(out).toContain("\x1b[31m");
    expect(stripAnsi(out)).toContain("⚠");
  });

  it("preserves ANSI styling in body content", () => {
    const styled = "\x1b[1mbold\x1b[0m plain";
    const out = renderOverlayBox({ title: "T", body: [styled], cols: 80, rows: 24 });
    expect(stripAnsi(out)).toContain("bold plain");
  });

  it("centers the box on the provided viewport, not a fixed width", () => {
    const firstCursor = (out: string): { row: number; col: number } => {
      const m = out.match(/\x1b\[(\d+);(\d+)H/);
      if (!m) throw new Error("no cursor-position escape found");
      return { row: Number(m[1]), col: Number(m[2]) };
    };
    const boxWidth = (out: string): number => {
      const top = stripAnsi(out.split(/\x1b\[\d+;\d+H/)[1] ?? "");
      return top.replace(/\x1b8$/, "").length;
    };
    const spec = { title: "Pick", body: ["  one", "  two"] };
    const narrow = renderOverlayBox({ ...spec, cols: 80, rows: 24 });
    const wide = renderOverlayBox({ ...spec, cols: 200, rows: 50 });

    // Same content → same box width at both viewports, but centered further right
    // when the viewport is wider. Centering follows the passed cols, not stdout.
    expect(firstCursor(wide).col).toBeGreaterThan(firstCursor(narrow).col);
    for (const [out, cols] of [
      [narrow, 80],
      [wide, 200],
    ] as const) {
      const { col } = firstCursor(out);
      expect(col).toBeGreaterThanOrEqual(1);
      expect(col + boxWidth(out)).toBeLessThanOrEqual(cols);
    }
  });

  it("pads and truncates every row to a uniform box width", () => {
    const out = renderOverlayBox({ title: "short", body: ["x".repeat(300)], cols: 80, rows: 24 });
    // Each row is emitted after a cursor-position escape; split on it and measure.
    const rows = out
      .split(/\x1b\[\d+;\d+H/)
      .slice(1)
      .map((segment) => stripAnsi(segment.replace(/\x1b8$/, "")).length)
      .filter((length) => length > 0);
    expect(rows.length).toBeGreaterThan(2);
    expect(new Set(rows).size).toBe(1);
    expect(rows[0]).toBeLessThanOrEqual(80);
  });
});
