import { describe, expect, it } from "vitest";

import {
  NARROW_ROW_CHIP_BUDGET,
  ROW_CHIP_BUDGET,
  rowChipColors,
  rowChipsOf,
  visibleRowChips,
  type RowChip,
} from "@/lib/row-chips";

const published: RowChip[] = [
  { kind: "waiting-on-me", label: "waiting on you", tone: "attention" },
  { kind: "coordination-blocked", label: "coordination blocked", tone: "danger" },
  { kind: "threads-unread", label: "8 threads unread", tone: "work" },
];

describe("the chips a row was handed", () => {
  it("reads them off the published presentation", () => {
    const session = { semantic: { presentation: { rowChips: published } } };
    expect(rowChipsOf(session)).toEqual(published);
  });

  it("has nothing to say when nothing published them", () => {
    expect(rowChipsOf({})).toEqual([]);
    expect(rowChipsOf({ semantic: undefined })).toEqual([]);
    expect(rowChipsOf({ semantic: { presentation: { statusLabel: "ready" } } })).toEqual([]);
  });

  it("drops a chip whose shape is not one, rather than rendering undefined", () => {
    // A build that publishes something else should cost a row its chips, not
    // its render.
    const session = {
      semantic: {
        presentation: {
          rowChips: [{ kind: "x" }, published[0]!, { label: "y", tone: "work" }] as RowChip[],
        },
      },
    };
    expect(rowChipsOf(session)).toEqual([published[0]]);
  });
});

describe("how many fit", () => {
  it("filters the published order and never reorders it", () => {
    const { visible, more } = visibleRowChips(published, ROW_CHIP_BUDGET);
    expect(visible.map((chip) => chip.kind)).toEqual(["waiting-on-me", "coordination-blocked"]);
    expect(more).toBe(true);
  });

  it("says there is more rather than dropping the rest in silence", () => {
    expect(visibleRowChips(published, NARROW_ROW_CHIP_BUDGET).more).toBe(true);
    expect(visibleRowChips(published, 0)).toEqual({ visible: [], more: true });
    expect(visibleRowChips(published, published.length).more).toBe(false);
    expect(visibleRowChips([], ROW_CHIP_BUDGET)).toEqual({ visible: [], more: false });
  });

  it("treats a negative budget as no room, not as the whole list", () => {
    expect(visibleRowChips(published, -1)).toEqual({ visible: [], more: true });
  });
});

describe("how this client paints a tone the service named", () => {
  // The exact pairs, not just that they differ: swapping attention and danger
  // paints "waiting on you" red and "coordination blocked" amber, which both
  // read as a working row with one urgent thing -- the wrong one.
  it("paints each tone its own colour", () => {
    expect(rowChipColors("attention").text).toBe("#e0b341");
    expect(rowChipColors("danger").text).toBe("#e05f5f");
    expect(rowChipColors("work").text).toBe("#78dce8");
    expect(rowChipColors("info").text).toBe("#a7b2e6");
    expect(rowChipColors("muted").text).toBe("#9aa0ad");
  });

  it("gives a tone from a newer build the muted pair rather than nothing", () => {
    expect(rowChipColors("something-new" as RowChip["tone"])).toEqual(rowChipColors("muted"));
  });
});
