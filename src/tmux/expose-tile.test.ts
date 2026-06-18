import { describe, expect, it } from "vitest";
import { stripAnsi } from "../tui/render/text.js";
import { buildBackdrop, buildTileHeader, drawTile, fitHeaderRows } from "./expose.js";

const PILL = "[PILL]";

describe("buildTileHeader", () => {
  it("inlines context in the rule when it fits, with the pill on its own row", () => {
    const { ruleTitle, headerRows } = buildTileHeader(50, 56, "X", "proj / wt", PILL, "", 0);
    expect(stripAnsi(ruleTitle)).toContain("proj / wt");
    expect(headerRows).toEqual([PILL]);
  });

  it("drops context to a dedicated row when the rule is too narrow", () => {
    const { ruleTitle, headerRows } = buildTileHeader(12, 16, "X", "proj / wt", PILL, "", 0);
    expect(stripAnsi(ruleTitle)).not.toContain("proj");
    expect(stripAnsi(headerRows[0]!)).toContain("proj / wt");
    expect(stripAnsi(headerRows[headerRows.length - 1]!)).toContain("PILL");
  });

  it("insets header rows so they line up under the title text", () => {
    const { headerRows } = buildTileHeader(12, 16, "X", "proj / wt", PILL, "", 2);
    for (const row of headerRows) expect(row.startsWith("  ")).toBe(true);
  });

  it("appends the status detail (last message) after the pill", () => {
    const { headerRows } = buildTileHeader(50, 56, "X", "", PILL, "shipping it", 0);
    expect(stripAnsi(headerRows.at(-1)!)).toBe("[PILL]  shipping it");
  });

  it("always gives the status pill its own row regardless of width", () => {
    expect(buildTileHeader(50, 56, "X", "", PILL, "", 0).headerRows).toEqual([PILL]);
    expect(stripAnsi(buildTileHeader(12, 16, "X", "proj / wt", PILL, "", 0).headerRows.at(-1)!)).toContain("PILL");
  });
});

describe("buildBackdrop", () => {
  it("returns empty for an empty capture", () => {
    expect(buildBackdrop("", 80, 24)).toBe("");
  });

  it("positions each line and dims it with the faint lead", () => {
    const out = buildBackdrop("hello\nworld", 80, 24);
    expect(out).toContain("\x1b[1;1H");
    expect(out).toContain("\x1b[2;1H");
    expect(out).toContain("\x1b[2;38;5;240m"); // recede faint lead
    expect(stripAnsi(out)).toContain("hello");
    expect(stripAnsi(out)).toContain("world");
  });

  it("keeps host colors (dimmed) but strips dangerous control sequences", () => {
    const out = buildBackdrop("\x1b[31mred\x1b[0m\x1b[5;5Htail", 80, 24);
    expect(out).toContain("\x1b[31m"); // color preserved under faint
    expect(out).not.toContain("\x1b[5;5H"); // cursor move stripped by sanitizeLine
    expect(stripAnsi(out)).toContain("redtail");
  });

  it("caps painted lines to the row budget", () => {
    const many = Array.from({ length: 50 }, (_, i) => `row${i}`).join("\n");
    const positions = (buildBackdrop(many, 80, 5).match(/\x1b\[\d+;1H/g) ?? []).length;
    expect(positions).toBe(5);
  });

  it("truncates each line to the column budget", () => {
    const out = buildBackdrop("x".repeat(200), 20, 24);
    expect((stripAnsi(out).match(/x/g) ?? []).length).toBeLessThanOrEqual(20);
  });
});

describe("fitHeaderRows", () => {
  it("returns rows unchanged when they fit the capacity", () => {
    expect(fitHeaderRows(["a", "b"], 3, true)).toEqual(["a", "b"]);
  });

  it("drops context rows but keeps the pill when over capacity", () => {
    expect(fitHeaderRows(["ctx1", "ctx2", "PILL"], 2, true)).toEqual(["ctx1", "PILL"]);
    expect(fitHeaderRows(["ctx1", "ctx2", "PILL"], 1, true)).toEqual(["PILL"]);
  });

  it("truncates from the end when there is no pill", () => {
    expect(fitHeaderRows(["a", "b", "c"], 2, false)).toEqual(["a", "b"]);
  });
});

function renderTile(
  width: number,
  selected: boolean,
  meta: Record<string, unknown>,
  sublabel: string,
  tileHeight = 6,
  preview: string[] = ["* Worked for 41s", "recap", "next"],
): string {
  const layout = {
    tileCols: 1,
    tileWidth: width,
    tileHeight,
    bodyLines: tileHeight - 3,
    visibleCount: 1,
    gridTopRow: 3,
  };
  const item = { id: "x", label: "claude(coder)", target: { windowId: "@1" }, metadata: meta, activity: 0 };
  return drawTile(item as never, preview, 3, selected, 1, 1, width, layout as never, sublabel, {
    currentWindowId: "@other",
  } as never);
}

describe("drawTile", () => {
  const needs = { activity: "running", attention: "needs_input", worktreePath: "/x/beautify-tui" };

  it("draws a heavy state-tinted frame for the selected tile and fills the tile height", () => {
    const out = renderTile(56, true, needs, "aimux / beautify-tui");
    expect(out).toContain("┏");
    expect(out).toContain("┗");
    expect(out).toContain("┃");
    expect(stripAnsi(out)).toContain("NEEDS INPUT");
    // Needs-input selected border tone (state color, not a distinct selection color).
    expect(out).toContain("\x1b[38;5;179m");
    const lines = out.split(/\x1b\[\d+;\d+H/).filter(Boolean);
    expect(lines.length).toBe(6);
  });

  it("uses a light frame in the same state tone when not selected, without the marker", () => {
    const out = renderTile(56, false, needs, "aimux / beautify-tui");
    expect(out).toContain("╭");
    expect(out).toContain("│");
    expect(out).not.toContain("┏");
    expect(out).toContain("\x1b[38;5;94m");
    expect(stripAnsi(out)).not.toContain("▸");
  });

  it("renders the dashboard-semantic user label (not the raw activity) as the pill", () => {
    // Raw activity "waiting" would read "WAITING"; the semantic label "working" wins.
    const out = renderTile(56, true, { activity: "waiting", userLabel: "working", worktreePath: "/x/wt" }, "p / wt");
    const plain = stripAnsi(out);
    expect(plain).toContain("WORKING");
    expect(plain).not.toContain("WAITING");
  });

  it("shows the agent status text (last message) on the pill row", () => {
    const out = renderTile(56, true, { ...needs, statusText: "wrapping it up" }, "aimux / beautify-tui");
    expect(stripAnsi(out)).toContain("wrapping it up");
  });

  it("shows the labeled time anchor (verb + recency) next to the pill", () => {
    // A minutes-bucket delta keeps the assertion stable against sub-second drift.
    const recencyAt = new Date(Date.now() - 7 * 60_000).toISOString();
    const out = renderTile(
      60,
      true,
      { ...needs, recencyAt, recencyLabel: "output", statusText: "wrapping it up" },
      "aimux / beautify-tui",
    );
    const plain = stripAnsi(out);
    expect(plain).toContain("output 7m ago");
    expect(plain).toContain("output 7m ago · wrapping it up");
  });

  it("keeps the recency/status row on a short tile even with no status pill", () => {
    const recencyAt = new Date(Date.now() - 7 * 60_000).toISOString();
    // No activity/attention → no pill; the row carries only recency, and must survive.
    const out = renderTile(
      34,
      true,
      { worktreePath: "/x/wt", recencyAt, recencyLabel: "output" },
      "proj / a-long-worktree-name",
      4,
    );
    const lines = out.split(/\x1b\[\d+;\d+H/).filter(Boolean);
    expect(lines.length).toBe(4);
    expect(stripAnsi(out)).toContain("output 7m ago");
  });

  it("inlines the worktree/project context in the top rule when wide", () => {
    const out = renderTile(60, true, needs, "aimux / beautify-tui");
    const topRule = out.split(/\x1b\[\d+;\d+H/).filter(Boolean)[0]!;
    expect(stripAnsi(topRule)).toContain("aimux / beautify-tui");
  });

  it("never exceeds the tile height even when the header would overflow a short tile", () => {
    const out = renderTile(34, true, needs, "some-project / a-rather-long-worktree-name", 4);
    const lines = out.split(/\x1b\[\d+;\d+H/).filter(Boolean);
    expect(lines.length).toBe(4);
    // The status pill survives even when context rows are dropped for space.
    expect(stripAnsi(out)).toContain("NEEDS INPUT");
  });

  it("flattens captured preview colors to gray so the tile chrome reads above them", () => {
    const colored = ["\x1b[31mRED error\x1b[0m here", "\x1b[32mgreen line\x1b[0m"];
    // `needs` gives a state-tinted border (94/179), never 240/250 — so the preview grays
    // below are unambiguous. Selected previews are the brightest (250); unselected dim (240).
    const sel = renderTile(56, true, needs, "aimux / beautify-tui", 8, colored);
    const unsel = renderTile(56, false, needs, "aimux / beautify-tui", 8, colored);
    for (const out of [sel, unsel]) {
      expect(out).not.toContain("\x1b[31m");
      expect(out).not.toContain("\x1b[32m");
      expect(stripAnsi(out)).toContain("RED error here");
      expect(stripAnsi(out)).toContain("green line");
    }
    expect(sel).toContain("\x1b[38;5;250m");
    expect(sel).not.toContain("\x1b[38;5;240m");
    expect(unsel).toContain("\x1b[38;5;240m");
    expect(unsel).not.toContain("\x1b[38;5;250m");
  });

  it("keeps every rendered line the same visible width (aligned borders)", () => {
    const out = renderTile(40, false, needs, "aimux / beautify-tui");
    const widths = out
      .split(/\x1b\[\d+;\d+H/)
      .filter(Boolean)
      .map((line) => stripAnsi(line).length);
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBe(40);
  });
});
