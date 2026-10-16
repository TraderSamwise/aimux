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
  it("gives each tone its own colour, and an unknown one the muted pair", () => {
    const tones = ["attention", "danger", "work", "info"] as const;
    const colors = tones.map((tone) => rowChipColors(tone).text);
    expect(new Set(colors).size).toBe(tones.length);
    // A tone from a newer build renders muted rather than invisible.
    expect(rowChipColors("something-new" as RowChip["tone"])).toEqual(rowChipColors("muted"));
  });
});
