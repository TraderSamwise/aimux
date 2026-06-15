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
