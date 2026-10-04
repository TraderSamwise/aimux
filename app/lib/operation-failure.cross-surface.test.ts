import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { summarizeOperationFailures } from "@/lib/unavailable-state";
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
  failure: ProjectOperationFailure;
  title: string;
  target: string;
}

const cases: PresentationCase[] = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")).cases;

describe("what the app's failure card shows", () => {
  it("has cases to check", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const testCase of cases) {
    it(`shows the shared title and target — ${testCase.why}`, () => {
      const summary = summarizeOperationFailures([testCase.failure]);
      expect(summary).not.toBeNull();
      // The title is the failure's own, not a generic "something failed".
      expect(summary?.title).toBe(testCase.title);
      // The target survives, because the title the service wrote names it.
      expect(`${summary?.title} ${summary?.detail}`).toContain(testCase.target);
    });
  }

  it("lists the titles when there are several, the way the CLI card does", () => {
    const summary = summarizeOperationFailures(cases.map((entry) => entry.failure));
    expect(summary?.title).toBe(`Project state has ${cases.length} operation failures`);
    for (const entry of cases) {
      expect(summary?.detail).toContain(entry.title);
    }
  });
});
