import { describe, expect, it } from "vitest";
import { balancedCols, computeLayout } from "./expose.js";

describe("balancedCols", () => {
  it("keeps a single row up to 3 tiles", () => {
    expect(balancedCols(1)).toBe(1);
    expect(balancedCols(2)).toBe(2);
    expect(balancedCols(3)).toBe(3);
  });

  it("grows toward a near-square beyond 3", () => {
    expect(balancedCols(4)).toBe(2); // 2x2
    expect(balancedCols(5)).toBe(3); // 2x3
    expect(balancedCols(6)).toBe(3); // 2x3
    expect(balancedCols(7)).toBe(3); // 3x3
    expect(balancedCols(9)).toBe(3); // 3x3
    expect(balancedCols(10)).toBe(4); // 3x4
    expect(balancedCols(12)).toBe(4); // 3x4
  });

  it("clamps a zero/negative count to at least one column", () => {
    expect(balancedCols(0)).toBe(1);
  });
});

describe("computeLayout grid shape on a roomy terminal", () => {
  // 200 cols fits ~6 columns at MIN_TILE_WIDTH=30; 50 rows leaves ample height.
  const WIDE = 200;
  const TALL = 50;

  it("uses the balanced column count when width allows", () => {
    expect(computeLayout(5, WIDE, TALL).tileCols).toBe(3);
    expect(computeLayout(4, WIDE, TALL).tileCols).toBe(2);
    expect(computeLayout(9, WIDE, TALL).tileCols).toBe(3);
  });

  it("never exceeds what the terminal width fits", () => {
    // Narrow terminal fits only 2 columns regardless of the balanced ideal.
    const layout = computeLayout(9, 70, TALL);
    expect(layout.tileCols).toBeLessThanOrEqual(2);
  });

  it("keeps a single full-width tile for one item", () => {
    expect(computeLayout(1, WIDE, TALL).tileCols).toBe(1);
  });
});
