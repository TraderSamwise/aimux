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

  it("spends every row but the title and help bars on the grid", () => {
    // Full-bleed: the layout is handed the raw viewport, not an inset panel's interior.
    const layout = computeLayout(4, WIDE, TALL);
    expect(layout.gridTopRow).toBe(1);
    expect(layout.gridHeight).toBe(TALL - 2);
    // Two rows of tiles claim the whole grid height, give or take the floor remainder.
    expect(layout.tileHeight * 2).toBeGreaterThanOrEqual(layout.gridHeight - 1);
  });

  it("spends every column but the grid gaps on tiles", () => {
    const layout = computeLayout(4, WIDE, TALL);
    expect(layout.tileWidth * layout.tileCols + (layout.tileCols - 1) * 1).toBeGreaterThanOrEqual(WIDE - 1);
  });

  it("keeps the grid inside the viewport, clear of the title and help bars", () => {
    for (const cols of [60, 80, 120, 200, 341]) {
      for (const rows of [12, 24, 41, 50, 90]) {
        for (const count of [1, 2, 4, 7, 12]) {
          const layout = computeLayout(count, cols, rows);
          const tileRows = Math.ceil(layout.visibleCount / layout.tileCols);
          const bottom = 1 + layout.gridTopRow + layout.tileHeight * tileRows - 1;
          const right = 1 + (layout.tileCols - 1) * (layout.tileWidth + 1) + layout.tileWidth - 1;
          const at = `${cols}x${rows}/${count}`;
          expect([at, bottom < rows]).toEqual([at, true]); // help bar owns the last row
          expect([at, right <= cols]).toEqual([at, true]);
        }
      }
    }
  });

  it("returns a finite layout for an empty rung", () => {
    const layout = computeLayout(0, WIDE, TALL);
    expect(layout.visibleCount).toBe(0);
    expect(Number.isFinite(layout.tileHeight)).toBe(true);
    expect(Number.isFinite(layout.bodyLines)).toBe(true);
  });
});
