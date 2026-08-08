import { describe, expect, it } from "vitest";
import { stripAnsi } from "../tui/render/text.js";
import {
  assignWorktreeTones,
  buildBackdrop,
  buildPanelFrame,
  buildTileHeader,
  drawTile,
  fitHeaderRows,
  matchClientSize,
  panelGeometry,
  type TileContext,
} from "./expose.js";

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

describe("panelGeometry", () => {
  it("centres an inset ~90% panel within the viewport", () => {
    const geo = panelGeometry(100, 40);
    expect(geo.width).toBe(90);
    expect(geo.height).toBe(36);
    expect(geo.left).toBe(6); // (100-90)/2 + 1
    expect(geo.top).toBe(3); // (40-36)/2 + 1
    // Margin on both sides shows the dimmed backdrop.
    expect(geo.left + geo.width - 1).toBeLessThan(100);
    expect(geo.top + geo.height - 1).toBeLessThan(40);
  });

  it("clamps to the viewport on tiny terminals (never larger than the screen)", () => {
    for (const [cols, rows] of [
      [34, 9],
      [20, 6],
      [10, 4],
    ] as const) {
      const geo = panelGeometry(cols, rows);
      expect(geo.width).toBeLessThanOrEqual(cols);
      expect(geo.height).toBeLessThanOrEqual(rows);
      expect(geo.left).toBeGreaterThanOrEqual(1);
      expect(geo.top).toBeGreaterThanOrEqual(1);
      expect(geo.left + geo.width - 1).toBeLessThanOrEqual(cols);
      expect(geo.top + geo.height - 1).toBeLessThanOrEqual(rows);
    }
  });
});

describe("buildPanelFrame", () => {
  it("draws an opaque bordered box positioned at the panel origin", () => {
    const out = buildPanelFrame({ top: 3, left: 6, width: 10, height: 4 });
    expect(out).toContain("\x1b[3;6H"); // top border at origin
    expect(out).toContain("\x1b[6;6H"); // bottom border row (top + height - 1)
    expect(out).toContain("╭");
    expect(out).toContain("╮");
    expect(out).toContain("╰");
    expect(out).toContain("╯");
    // Body rows fill the interior with opaque spaces (width - 2).
    expect(out).toContain("│\x1b[0m" + " ".repeat(8) + "\x1b[38;5;248m│");
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

const ctx = (project: string, worktree: string, tone = 0): TileContext => ({ project, worktree, tone });

function renderTile(
  width: number,
  selected: boolean,
  meta: Record<string, unknown>,
  context: TileContext,
  tileHeight = 6,
  preview: string[] = ["* Worked for 41s", "recap", "next"],
  dimInactive = false,
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
  return drawTile(
    item as never,
    preview,
    3,
    selected,
    1,
    1,
    width,
    layout as never,
    context,
    { currentWindowId: "@other" } as never,
    dimInactive,
  );
}

describe("drawTile", () => {
  const needs = { activity: "running", attention: "needs_input", worktreePath: "/x/beautify-tui" };

  it("draws a double accent frame for the selected tile and fills the tile height", () => {
    const out = renderTile(56, true, needs, ctx("aimux", "beautify-tui"));
    expect(out).toContain("╔");
    expect(out).toContain("╚");
    expect(out).toContain("║");
    expect(stripAnsi(out)).toContain("NEEDS INPUT");
    // Selection owns both channels now: the accent border, not the state tone. The
    // state stays readable on the pill.
    expect(out).toContain("\x1b[1;33m");
    expect(out).not.toContain("\x1b[38;5;179m");
    const lines = out.split(/\x1b\[\d+;\d+H/).filter(Boolean);
    expect(lines.length).toBe(6);
  });

  it("uses a light frame at full state tone when not selected, without the marker", () => {
    const out = renderTile(56, false, needs, ctx("aimux", "beautify-tui"));
    expect(out).toContain("╭");
    expect(out).toContain("│");
    expect(out).not.toContain("╔");
    expect(out).toContain("\x1b[38;5;179m"); // bright state tone by default — inactive tiles aren't dimmed
    expect(out).not.toContain("\x1b[38;5;94m");
    expect(stripAnsi(out)).not.toContain("▸");
  });

  it("dims the inactive border only when dimInactive is enabled", () => {
    const out = renderTile(56, false, needs, ctx("aimux", "beautify-tui"), 6, undefined, true);
    expect(out).toContain("\x1b[38;5;94m"); // dim (off) state tone
    expect(out).not.toContain("\x1b[38;5;179m");
  });

  it("renders the dashboard-semantic user label (not the raw activity) as the pill", () => {
    // Raw activity "waiting" would read "WAITING"; the semantic label "working" wins.
    const out = renderTile(
      56,
      true,
      { activity: "waiting", userLabel: "working", worktreePath: "/x/wt" },
      ctx("p", "wt"),
    );
    const plain = stripAnsi(out);
    expect(plain).toContain("WORKING");
    expect(plain).not.toContain("WAITING");
  });

  it("shows the agent status text (last message) on the pill row", () => {
    const out = renderTile(56, true, { ...needs, statusText: "wrapping it up" }, ctx("aimux", "beautify-tui"));
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
    const out = renderTile(60, true, needs, ctx("aimux", "beautify-tui"));
    const topRule = out.split(/\x1b\[\d+;\d+H/).filter(Boolean)[0]!;
    expect(stripAnsi(topRule)).toContain("aimux / beautify-tui");
  });

  it("never exceeds the tile height even when the header would overflow a short tile", () => {
    const out = renderTile(34, true, needs, ctx("some-project", "a-rather-long-worktree-name"), 4);
    const lines = out.split(/\x1b\[\d+;\d+H/).filter(Boolean);
    expect(lines.length).toBe(4);
    // The status pill survives even when context rows are dropped for space.
    expect(stripAnsi(out)).toContain("NEEDS INPUT");
  });

  it("keeps preview colors by default, dimming only inactive tiles when dimInactive is on", () => {
    const colored = ["\x1b[31mRED error\x1b[0m here", "\x1b[32mgreen line\x1b[0m"];
    // Default: every tile keeps the captured pane's real colors, no gray flatten.
    for (const sel of [true, false]) {
      const out = renderTile(56, sel, needs, ctx("aimux", "beautify-tui"), 8, colored, false);
      expect(out).toContain("\x1b[31m");
      expect(out).toContain("\x1b[32m");
      expect(out).not.toContain("\x1b[38;5;240m");
    }
    // dimInactive on: the active tile stays colored; only the inactive tile flattens to gray.
    const active = renderTile(56, true, needs, ctx("aimux", "beautify-tui"), 8, colored, true);
    const inactive = renderTile(56, false, needs, ctx("aimux", "beautify-tui"), 8, colored, true);
    expect(active).toContain("\x1b[31m");
    expect(inactive).not.toContain("\x1b[31m");
    expect(inactive).toContain("\x1b[38;5;240m"); // deep gray flatten
    expect(stripAnsi(inactive)).toContain("RED error here");
  });

  it("keeps every rendered line the same visible width (aligned borders)", () => {
    const out = renderTile(40, false, needs, ctx("aimux", "beautify-tui"));
    const widths = out
      .split(/\x1b\[\d+;\d+H/)
      .filter(Boolean)
      .map((line) => stripAnsi(line).length);
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBe(40);
  });

  it("leads the rule with the worktree and trails the agent name muted", () => {
    const topRule = (out: string) => stripAnsi(out.split(/\x1b\[\d+;\d+H/).filter(Boolean)[0]!);
    // The worktree comes first and the agent name after it — the reverse of the old
    // `claude(coder) · beautify-tui` order.
    expect(topRule(renderTile(60, true, needs, ctx("aimux", "beautify-tui")))).toContain("beautify-tui  claude(coder)");
  });

  it("tints the worktree by its group tone, leaving the project prefix muted", () => {
    const out = renderTile(60, false, needs, { project: "aimux", worktree: "beautify-tui", tone: 1 });
    // Bold in BAND_TONES[1]; the badge borrows the same tone when unselected.
    expect(out).toContain("\x1b[1;38;5;71mbeautify-tui\x1b[0m");
    expect(out).toContain("\x1b[1;38;5;71m3\x1b[0m");
    expect(out).toContain("\x1b[2maimux / \x1b[0m");
  });

  it("keeps the badge on the accent when selected so focus never reads as a group tone", () => {
    const out = renderTile(60, true, needs, { project: "aimux", worktree: "beautify-tui", tone: 1 });
    expect(out).toContain("\x1b[1;33m3\x1b[0m");
    expect(out).not.toContain("\x1b[1;38;5;71m3\x1b[0m");
    // The worktree still carries the tone; only the badge is claimed by selection.
    expect(out).toContain("\x1b[1;38;5;71mbeautify-tui\x1b[0m");
  });

  it("falls back to a bold agent name when the scope has no worktree to show", () => {
    // The worktree scope: every tile shares one worktree, so naming it says nothing.
    const out = renderTile(60, false, needs, { worktree: "" });
    const topRule = stripAnsi(out.split(/\x1b\[\d+;\d+H/).filter(Boolean)[0]!);
    expect(topRule).toContain("3 claude(coder)");
    expect(out).toContain("\x1b[1mclaude(coder)\x1b[0m");
  });

  it("keeps the worktree in the rule under width pressure and drops the agent name below", () => {
    // The reverse of the old priority: the worktree now holds the rule (truncating if
    // it must) and the agent name is what gets a wrapped row.
    const out = renderTile(34, true, needs, { worktree: "a-rather-long-worktree-name", tone: 0 }, 6);
    const rows = out.split(/\x1b\[\d+;\d+H/).filter(Boolean);
    expect(stripAnsi(rows[0]!)).toContain("a-rather-long-worktree-…");
    expect(stripAnsi(rows[1]!)).toContain("claude(coder)");
  });
});

describe("matchClientSize", () => {
  // The shape `tmux list-clients -F '#{client_tty} #{client_width}x#{client_height}'` emits.
  const listing = ["/dev/ttys031 114x50", "/dev/ttys052 114x50", "/dev/ttys079 90x30"].join("\n");

  it("returns the size of the requested client, not the first one listed", () => {
    // The bug this replaced: `display-message -c` answered for a sibling client, so a
    // resize of the client actually running Exposé was invisible.
    expect(matchClientSize(listing, "/dev/ttys079")).toBe("90x30");
    expect(matchClientSize(listing, "/dev/ttys031")).toBe("114x50");
  });

  it("matches on the bare tty name as well as the full device path", () => {
    expect(matchClientSize(listing, "ttys079")).toBe("90x30");
  });

  it("returns empty when the client is gone or the listing is unusable", () => {
    expect(matchClientSize(listing, "/dev/ttys999")).toBe("");
    expect(matchClientSize("", "/dev/ttys079")).toBe("");
    expect(matchClientSize("garbage-with-no-size\n", "garbage-with-no-size")).toBe("");
  });

  it("ignores blank and short lines rather than mis-parsing them", () => {
    expect(matchClientSize(`\n  \n${listing}\n\n`, "/dev/ttys079")).toBe("90x30");
  });
});

describe("assignWorktreeTones", () => {
  const item = (worktreePath: string, projectRoot?: string) =>
    ({ metadata: { worktreePath }, ...(projectRoot ? { projectRoot } : {}) }) as never;

  it("assigns tones in first-seen order so neighbouring worktrees differ", () => {
    const tones = assignWorktreeTones([item("/p/a"), item("/p/b"), item("/p/a"), item("/p/c")], "/p");
    expect([...tones.values()]).toEqual([0, 1, 2]);
    expect(tones.get("/p/a")).toBe(0);
    expect(tones.get("/p/b")).toBe(1);
    expect(tones.get("/p/c")).toBe(2);
  });

  it("gives every agent in one worktree the same tone", () => {
    const tones = assignWorktreeTones([item("/p/a"), item("/p/a"), item("/p/a")], "/p");
    expect(tones.size).toBe(1);
  });

  it("keys by resolved path, so each project's main checkout is its own group", () => {
    // Both render as "main"; keying by the displayed name would merge them.
    const tones = assignWorktreeTones([item("", "/one"), item("", "/two")], "/fallback");
    expect(tones.get("/one")).toBe(0);
    expect(tones.get("/two")).toBe(1);
  });

  it("falls back to the project root when an item carries no worktree path", () => {
    expect(assignWorktreeTones([item("")], "/p").get("/p")).toBe(0);
  });

  it("wraps around the palette rather than running out of tones", () => {
    const many = Array.from({ length: 7 }, (_, i) => item(`/p/w${i}`));
    const tones = assignWorktreeTones(many, "/p");
    expect(tones.get("/p/w6")).toBe(0);
    expect(tones.size).toBe(7);
  });
});
