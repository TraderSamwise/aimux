import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  TOPOLOGY_INDENT_BASE_PX,
  TOPOLOGY_INDENT_PER_DEPTH_PX,
  topologyRowIndent,
} from "@/lib/topology-rows";

// The app half of the cross-surface delegation-depth check. AGENTS.md "One
// Answer, Many Surfaces": the project service decides how deep an agent sits
// by walking the supervision edge once, and each surface only multiplies it.
// This row used to indent by `depth > 0`, which drew a three-level org as one
// flat list of peers under its checkout.
//
// The service half is native/crates/aimux/tests/topology_depth_surfaces.rs,
// which asserts the same file's depths and row order are what
// `build_project_topology` actually produces -- so the numbers below are not
// this test's opinion.
const FIXTURE_PATH = join(
  __dirname,
  "..",
  "..",
  "testdata",
  "contracts",
  "v1",
  "topology-depth",
  "surfaces.json",
);

interface ExpectedRow {
  kind: string;
  label?: string;
  sessionId?: string;
  depth: number;
  tuiIndent: number;
  appIndent: number;
  managedElsewhere?: boolean;
}

interface DepthCase {
  why: string;
  rows: ExpectedRow[];
}

interface DepthFixture {
  indent: {
    tuiBaseColumns: number;
    tuiColumnsPerDepth: number;
    appBasePixels: number;
    appPixelsPerDepth: number;
  };
  cases: DepthCase[];
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as DepthFixture;

describe("topologyRowIndent", () => {
  it("matches the padding the shared contract records for every depth", () => {
    for (const depthCase of fixture.cases) {
      for (const row of depthCase.rows) {
        expect(topologyRowIndent(row.depth), `${depthCase.why}: depth ${row.depth}`).toBe(
          row.appIndent,
        );
      }
    }
  });

  it("uses the base and step the contract names", () => {
    expect(TOPOLOGY_INDENT_BASE_PX).toBe(fixture.indent.appBasePixels);
    expect(TOPOLOGY_INDENT_PER_DEPTH_PX).toBe(fixture.indent.appPixelsPerDepth);
    expect(topologyRowIndent(0)).toBe(fixture.indent.appBasePixels);
    for (let depth = 0; depth < 6; depth += 1) {
      expect(topologyRowIndent(depth)).toBe(
        fixture.indent.appBasePixels + depth * fixture.indent.appPixelsPerDepth,
      );
    }
  });

  it("grows with depth rather than flattening everything below the top", () => {
    // The defect this replaced: every depth past the first drew identically,
    // so a manager and its report sat at the same indent.
    const indents = [0, 1, 2, 3].map(topologyRowIndent);
    expect(new Set(indents).size).toBe(indents.length);
  });

  it("does not let a missing or malformed depth throw the row off the screen", () => {
    expect(topologyRowIndent(-1)).toBe(fixture.indent.appBasePixels);
    expect(topologyRowIndent(Number.NaN)).toBe(fixture.indent.appBasePixels);
    expect(topologyRowIndent(1.7)).toBe(topologyRowIndent(1));
  });
});
