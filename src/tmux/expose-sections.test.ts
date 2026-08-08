import { describe, expect, it } from "vitest";

import {
  drawBand,
  groupItemsByProject,
  moveExposeIndexVertically,
  orderExposeItems,
  planExposeSections,
  type ExposeSectionGroup,
} from "./expose.js";
import type { ExposeScopeItem, ExposeScopeView } from "./expose-model.js";

function item(id: string, projectName?: string): ExposeScopeItem {
  return {
    label: id,
    target: { windowId: id, windowName: id },
    metadata: {},
    projectName,
  } as unknown as ExposeScopeItem;
}

function view(items: ExposeScopeItem[], sublabel: ExposeScopeView["sublabel"]): ExposeScopeView {
  return { scope: "global", items, scopeLabel: "all projects", sublabel };
}

const groups = (...pairs: Array<[string, number]>): ExposeSectionGroup[] =>
  pairs.map(([label, count]) => ({ label, count }));

describe("groupItemsByProject", () => {
  it("keeps first-seen project order and item order inside a project", () => {
    const result = groupItemsByProject([
      item("b1", "beta"),
      item("a1", "alpha"),
      item("b2", "beta"),
      item("a2", "alpha"),
    ]);
    expect(result.map((g) => g.label)).toEqual(["beta", "alpha"]);
    expect(result[0]!.items.map((i) => i.target.windowId)).toEqual(["b1", "b2"]);
    expect(result[1]!.items.map((i) => i.target.windowId)).toEqual(["a1", "a2"]);
  });

  it("buckets items with no project name under one label", () => {
    const result = groupItemsByProject([item("x"), item("y", "  ")]);
    expect(result).toHaveLength(1);
    expect(result[0]!.label).toBe("unknown project");
  });
});

describe("orderExposeItems", () => {
  it("regroups items by project when bands will be drawn", () => {
    const ordered = orderExposeItems(
      view([item("b1", "beta"), item("a1", "alpha"), item("b2", "beta")], "project-worktree"),
    );
    expect(ordered.map((i) => i.target.windowId)).toEqual(["b1", "b2", "a1"]);
  });

  it("leaves order alone for a single project or a narrower scope", () => {
    const single = [item("a1", "alpha"), item("a2", "alpha")];
    expect(orderExposeItems(view(single, "project-worktree"))).toBe(single);
    const mixed = [item("b1", "beta"), item("a1", "alpha")];
    expect(orderExposeItems(view(mixed, "worktree"))).toBe(mixed);
  });
});

describe("planExposeSections", () => {
  it("gives each project a band row and restarts its tiles at column 0", () => {
    const plan = planExposeSections(groups(["alpha", 4], ["beta", 2]), 3, 5, 40);
    expect(plan.bands.map((b) => [b.label, b.row, b.count])).toEqual([
      ["alpha", 0, 4],
      ["beta", 11, 2],
    ]);
    // alpha: band at 0, tiles at 1 (cols 0..2) then 6 (col 0). beta band 11, tiles 12.
    expect(plan.slots).toEqual([
      { row: 1, col: 0 },
      { row: 1, col: 1 },
      { row: 1, col: 2 },
      { row: 6, col: 0 },
      { row: 12, col: 0 },
      { row: 12, col: 1 },
    ]);
    expect(plan.visibleCount).toBe(6);
  });

  it("drops tiles that run past the grid instead of overflowing it", () => {
    const plan = planExposeSections(groups(["alpha", 6]), 2, 5, 12);
    // band at 0, tile rows at 1 and 6; a third row would end at 16 > 12.
    expect(plan.visibleCount).toBe(4);
    expect(plan.slots.at(-1)).toEqual({ row: 6, col: 1 });
  });

  it("drops a whole section rather than orphaning its band", () => {
    const plan = planExposeSections(groups(["alpha", 2], ["beta", 2]), 2, 5, 8);
    expect(plan.bands.map((b) => b.label)).toEqual(["alpha"]);
    expect(plan.visibleCount).toBe(2);
  });

  it("tones bands by position so neighbours differ", () => {
    const plan = planExposeSections(groups(["a", 1], ["b", 1], ["c", 1]), 3, 5, 40);
    expect(plan.bands.map((b) => b.tone)).toEqual([0, 1, 2]);
  });
});

describe("moveExposeIndexVertically", () => {
  // alpha rows: [0,1,2] then [3]; beta row: [4,5].
  const plan = planExposeSections(groups(["alpha", 4], ["beta", 2]), 3, 5, 60);
  const slots = plan.slots;

  it("holds the column when the next row is wide enough", () => {
    // Two full rows of three, so column 1 has a partner directly below it.
    const even = planExposeSections(groups(["alpha", 3], ["beta", 3]), 3, 5, 60).slots;
    expect(moveExposeIndexVertically(even, 1, 1, 6)).toBe(4);
  });

  it("falls back to the last tile of a shorter row", () => {
    // alpha's second row holds only column 0, so columns 1 and 2 both land on it.
    expect(moveExposeIndexVertically(slots, 1, 1, 6)).toBe(3);
    expect(moveExposeIndexVertically(slots, 2, 1, 6)).toBe(3);
  });

  it("crosses a section boundary going down and comes back going up", () => {
    const down = moveExposeIndexVertically(slots, 3, 1, 6);
    expect(down).toBe(4);
    expect(moveExposeIndexVertically(slots, down, -1, 6)).toBe(3);
  });

  it("stays put at the top and bottom edges", () => {
    expect(moveExposeIndexVertically(slots, 0, -1, 6)).toBe(0);
    expect(moveExposeIndexVertically(slots, 5, 1, 6)).toBe(5);
  });
});

describe("drawBand", () => {
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

  it("names the project, counts its agents, and fills the width exactly", () => {
    const out = drawBand({ row: 0, label: "tealstreet-next", count: 4, tone: 0 }, 5, 2, 60);
    const text = stripAnsi(out);
    expect(text).toContain("▌ tealstreet-next ");
    expect(text).toContain("4 agents");
    expect(text.length).toBe(60);
  });

  it("says agent, not agents, for one", () => {
    expect(stripAnsi(drawBand({ row: 0, label: "solo", count: 1, tone: 1 }, 1, 1, 40))).toContain("1 agent");
  });

  it("truncates rather than overflowing a narrow panel", () => {
    const out = stripAnsi(drawBand({ row: 0, label: "a-very-long-project-name-here", count: 12, tone: 2 }, 1, 1, 20));
    expect(out.length).toBeLessThanOrEqual(20);
  });
});
