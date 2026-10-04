import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { operationFailureRow, summarizeOperationFailures } from "@/lib/unavailable-state";
import type { ProjectOperationFailure } from "../../src/project-api-contract";

// The app half of the cross-surface operation-failure check. AGENTS.md "One
// Answer, Many Surfaces": a per-surface test passes happily while the surfaces
// disagree. The CLI reads this same file in
// native/crates/aimux/tests/operation_failure_surfaces.rs.
//
// Both cards are fed by one ledger now that a refusal is recorded there, so
// what is pinned is which facts each shows -- not the layout, which differs on
// purpose.
const FIXTURE_PATH = join(
  __dirname,
  "..",
  "..",
  "testdata",
  "contracts",
  "v1",
  "operation-failure-presentation",
  "surfaces.json",
);

interface PresentationCase {
  why: string;
  /** The STORED ledger row, as the file on disk holds it. */
  failure: ProjectOperationFailure;
  title: string;
  /** What the project service derives from the row; null when there is nothing to name. */
  target: string | null;
}

const cases: PresentationCase[] = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")).cases;

// The row a client actually receives. The service derives `target` once and
// ships it alongside the stored fields; the app renders that and does not walk
// a chain of its own, so the test has to hand it the published shape. The Rust
// half pins the derivation itself against the same `target`.
function published(testCase: PresentationCase): ProjectOperationFailure {
  return testCase.target === null
    ? testCase.failure
    : { ...testCase.failure, target: testCase.target };
}

describe("what the app's failure card shows", () => {
  it("has cases to check", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const testCase of cases) {
    it(`shows the shared title and target — ${testCase.why}`, () => {
      const summary = summarizeOperationFailures([published(testCase)]);
      expect(summary).not.toBeNull();
      // The title is the failure's own, not a generic "something failed".
      expect(summary?.title).toBe(testCase.title);
      if (testCase.target === null) {
        // Nothing to name, so nothing is named. The detail carries the message
        // alone -- it must not pick up a stray separator from an empty target.
        expect(summary?.detail).toBe(testCase.failure.message);
      } else {
        expect(`${summary?.title} ${summary?.detail}`).toContain(testCase.target);
      }
    });
  }

  // The card lists the first three and counts the rest, so a single pass only
  // ever exercises three of the fixture's cases -- which left the two added for
  // the shapes that break the old rule (a null target, and a title that does
  // not spell its target) never reaching this assertion at all. Rotating puts
  // every case in the rendered window.
  for (let offset = 0; offset < cases.length; offset += 1) {
    const window = Array.from({ length: 3 }, (_, i) => cases[(offset + i) % cases.length]);
    it(`names the target on every row when there are several — from case ${offset + 1}`, () => {
      // Reverting the single-failure path to its old format passed this suite
      // while the multi path listed bare titles: three refused graveyards read
      // as the same sentence three times with nothing saying which worktrees.
      // The CLI card renders title + target on every row, so this one does too.
      const summary = summarizeOperationFailures(window.map(published));
      expect(summary?.title).toBe(`Project state has ${window.length} operation failures`);
      for (const entry of window) {
        expect(summary?.detail).toContain(entry.title);
        if (entry.target !== null && !entry.title.includes(entry.target)) {
          expect(summary?.detail).toContain(entry.target);
        }
      }
    });
  }

  for (const testCase of cases) {
    it(`puts the target on its own row when the title omits it — ${testCase.why}`, () => {
      const row = operationFailureRow(published(testCase));
      expect(row).toContain(testCase.title);
      if (testCase.target !== null && !testCase.title.includes(testCase.target)) {
        expect(row).toContain(testCase.target);
      }
      // And never twice: the CLI card does not repeat a name the title spells.
      if (testCase.target !== null && testCase.title.includes(testCase.target)) {
        expect(row).toBe(testCase.title);
      }
    });
  }
});
