import { describe, expect, it } from "vitest";

import { reuseUnchangedEntries } from "./structural-reuse";

interface Row {
  id: string;
  status: string;
}

const rows = (...ids: Array<[string, string]>): Row[] =>
  ids.map(([id, status]) => ({ id, status }));

const byId = (row: Row) => row.id;

describe("entries that did not change keep their identity", () => {
  it("returns the previous array when nothing changed at all", () => {
    const previous = rows(["a", "running"], ["b", "idle"]);
    const next = rows(["a", "running"], ["b", "idle"]);

    expect(reuseUnchangedEntries(previous, next, byId)).toBe(previous);
  });

  it("reuses the untouched entry and takes the changed one", () => {
    const previous = rows(["a", "running"], ["b", "idle"]);
    const next = rows(["a", "running"], ["b", "running"]);

    const merged = reuseUnchangedEntries(previous, next, byId);

    expect(merged).not.toBe(previous);
    expect(merged[0]).toBe(previous[0]);
    expect(merged[1]).toBe(next[1]);
  });

  it("passes through when there is no previous list", () => {
    const next = rows(["a", "running"]);
    expect(reuseUnchangedEntries(undefined, next, byId)).toBe(next);
    expect(reuseUnchangedEntries([], next, byId)).toBe(next);
  });
});

// These are the cases where a wrongly-held reference shows up as a screen that
// stopped updating, which is the failure mode this whole optimisation risks.
describe("a changed list is never reported as unchanged", () => {
  it("does not report a reorder as unchanged", () => {
    const previous = rows(["a", "running"], ["b", "idle"]);
    const next = rows(["b", "idle"], ["a", "running"]);

    const merged = reuseUnchangedEntries(previous, next, byId);

    expect(merged, "a reordered list is a changed list").not.toBe(previous);
    expect(merged.map(byId)).toEqual(["b", "a"]);
  });

  it("does not report a removal as unchanged", () => {
    const previous = rows(["a", "running"], ["b", "idle"]);
    const next = rows(["a", "running"]);

    const merged = reuseUnchangedEntries(previous, next, byId);

    expect(merged).not.toBe(previous);
    expect(merged.map(byId)).toEqual(["a"]);
  });

  it("does not report an addition as unchanged", () => {
    const previous = rows(["a", "running"]);
    const next = rows(["a", "running"], ["b", "idle"]);

    const merged = reuseUnchangedEntries(previous, next, byId);

    expect(merged).not.toBe(previous);
    expect(merged.map(byId)).toEqual(["a", "b"]);
  });

  it("does not reuse an entry whose id was recycled with different content", () => {
    const previous = rows(["a", "running"]);
    const next = rows(["a", "exited"]);

    const merged = reuseUnchangedEntries(previous, next, byId);

    expect(merged[0]).toBe(next[0]);
    expect(merged[0].status).toBe("exited");
  });

  it("keeps both entries when two share an identity key", () => {
    // `path ?? name ?? ""` can key two worktrees to the same string.
    const previous = [
      { id: "", status: "running" },
      { id: "", status: "idle" },
    ];
    const next = [
      { id: "", status: "running" },
      { id: "", status: "idle" },
    ];

    const merged = reuseUnchangedEntries(previous, next, byId);

    expect(merged).toHaveLength(2);
    expect(merged.map((row) => row.status)).toEqual(["running", "idle"]);
  });
});
