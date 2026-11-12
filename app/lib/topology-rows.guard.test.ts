import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The row has to actually apply the depth.
//
// `topology-rows.test.ts` proves the helper returns the padding the shared
// contract records, and would stay green if the screen stopped passing it --
// which is the whole defect: the row indented by `depth > 0`, so a manager and
// its report sat at the same offset and a three-level org read as peers.
const SCREEN_PATH = join(__dirname, "..", "app", "(main)", "(tabs)", "topology", "index.tsx");
const screen = readFileSync(SCREEN_PATH, "utf8");

describe("the topology row", () => {
  it("pads itself from the shared depth helper", () => {
    expect(screen).toContain('from "@/lib/topology-rows"');
    expect(screen).toMatch(/paddingLeft:\s*topologyRowIndent\(\s*row\.depth\s*\)/);
  });

  it("does not indent by a boolean read of the depth", () => {
    // `row.depth > 0 && "pl-8"` and anything shaped like it: one offset for
    // everything below the top of the tree.
    expect(screen).not.toMatch(/row\.depth\s*[><!=]/);
  });

  it("says when an agent's manager is not among the rows", () => {
    // Unmarked, such a row is indistinguishable from an agent nobody manages.
    expect(screen).toContain("row.managerNotShown");
  });
});
