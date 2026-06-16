import { describe, expect, it } from "vitest";
import { stripAnsi } from "../tui/render/text.js";
import { buildTileHeader, drawTile } from "./expose.js";

const PILL = "[PILL]";

describe("buildTileHeader", () => {
  it("inlines context in the rule when it fits, with the pill on its own row", () => {
    const { ruleTitle, headerRows } = buildTileHeader(50, 56, "X", "proj / wt", PILL);
    expect(stripAnsi(ruleTitle)).toContain("proj / wt");
    expect(headerRows).toEqual([PILL]);
  });

  it("drops context to a dedicated row when the rule is too narrow", () => {
    const { ruleTitle, headerRows } = buildTileHeader(12, 16, "X", "proj / wt", PILL);
    expect(stripAnsi(ruleTitle)).not.toContain("proj");
    expect(stripAnsi(headerRows[0]!)).toContain("proj / wt");
    expect(headerRows[headerRows.length - 1]).toBe(PILL);
  });

  it("always gives the status pill its own row regardless of width", () => {
    expect(buildTileHeader(50, 56, "X", "", PILL).headerRows).toEqual([PILL]);
    expect(buildTileHeader(12, 16, "X", "proj / wt", PILL).headerRows.at(-1)).toBe(PILL);
  });
});

function renderTile(width: number, selected: boolean, meta: Record<string, unknown>, sublabel: string): string {
  const layout = { tileCols: 1, tileWidth: width, tileHeight: 6, bodyLines: 3, visibleCount: 1, gridTopRow: 3 };
  const item = { id: "x", label: "claude(coder)", target: { windowId: "@1" }, metadata: meta, activity: 0 };
  return drawTile(
    item as never,
    ["* Worked for 41s", "recap", "next"],
    3,
    selected,
    1,
    1,
    width,
    layout as never,
    sublabel,
    { currentWindowId: "@other" } as never,
  );
}

describe("drawTile", () => {
  const needs = { activity: "running", attention: "needs_input", worktreePath: "/x/beautify-tui" };

  it("draws a rounded, state-tinted frame with a status pill and fills the tile height", () => {
    const out = renderTile(56, true, needs, "aimux / beautify-tui");
    expect(out).toContain("╭");
    expect(out).toContain("╰");
    expect(stripAnsi(out)).toContain("NEEDS INPUT");
    // Needs-input selected border tone.
    expect(out).toContain("\x1b[38;5;179m");
    const lines = out.split(/\x1b\[\d+;\d+H/).filter(Boolean);
    expect(lines.length).toBe(6);
  });

  it("dims the border when not selected and omits the selection marker", () => {
    const out = renderTile(56, false, needs, "aimux / beautify-tui");
    expect(out).toContain("\x1b[38;5;94m");
    expect(stripAnsi(out)).not.toContain("▸");
  });

  it("inlines the worktree/project context in the top rule when wide", () => {
    const out = renderTile(60, true, needs, "aimux / beautify-tui");
    const topRule = out.split(/\x1b\[\d+;\d+H/).filter(Boolean)[0]!;
    expect(stripAnsi(topRule)).toContain("aimux / beautify-tui");
  });
});
