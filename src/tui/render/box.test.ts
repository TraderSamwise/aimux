import { describe, expect, it } from "vitest";
import { renderOverlayBox } from "./box.js";
import { stripAnsi } from "./text.js";

describe("renderOverlayBox", () => {
  it("draws a rounded box with the requested tone", () => {
    const out = renderOverlayBox(["Title", "", "  body line"], 80, 24, "blue");
    const plain = stripAnsi(out);
    expect(plain).toContain("╭");
    expect(plain).toContain("╮");
    expect(plain).toContain("╰");
    expect(plain).toContain("╯");
    expect(plain).toContain("│");
    expect(plain).toContain("Title");
    expect(out).toContain("\x1b[34m");
  });

  it("uses the danger tone for the red variant", () => {
    const out = renderOverlayBox(["Danger"], 80, 24, "red");
    expect(out).toContain("\x1b[31m");
  });

  it("preserves ANSI styling in body content without breaking width", () => {
    const styled = "\x1b[1mbold\x1b[0m plain";
    const out = renderOverlayBox([styled], 80, 24);
    expect(stripAnsi(out)).toContain("bold plain");
  });
});
