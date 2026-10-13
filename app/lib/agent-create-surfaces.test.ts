import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every surface that creates a worktree or an agent asks the same helper.
 *
 * AGENTS.md "One Answer, Many Surfaces" asks for a test that compares the
 * surfaces rather than one test per surface: a per-surface test passes happily
 * while the surfaces disagree, which is exactly how this class survives. These
 * rules had already drifted once -- the two Project-screen panels kicked
 * different refresh lists for the same project -- so the thing worth pinning is
 * that none of them re-derives the rules locally.
 */

const APP_ROOT = join(import.meta.dirname, "..");

const CREATION_SURFACES = [
  "components/CreateInProjectDialog.tsx",
  "components/agent-create-panel.tsx",
  "components/worktree-management-panel.tsx",
];

function source(relative: string): string {
  return readFileSync(join(APP_ROOT, relative), "utf8");
}

describe("the surfaces that create things agree", () => {
  it("has more than one surface, or this gate is measuring nothing", () => {
    expect(CREATION_SURFACES.length).toBeGreaterThan(1);
    for (const file of CREATION_SURFACES) {
      expect(source(file).length).toBeGreaterThan(0);
    }
  });

  it("gets the rules from lib/agent-create rather than restating them", () => {
    for (const file of CREATION_SURFACES) {
      expect(source(file)).toContain('from "@/lib/agent-create"');
    }
  });

  it("does not let a surface keep its own tool list", () => {
    // The literal is what a second copy looks like: `["claude", "codex", …]`
    // sitting next to a renderer is the drift this file exists to catch.
    for (const file of CREATION_SURFACES) {
      expect(source(file)).not.toMatch(/\[\s*"claude"/);
    }
  });

  it("does not let a surface re-derive which worktrees can host an agent", () => {
    // The old filter, inlined. Two copies of it is how one surface came to
    // offer a worktree whose directory was gone while another did not.
    for (const file of CREATION_SURFACES) {
      expect(source(file)).not.toMatch(/isMainCheckout\s*&&/);
    }
  });

  it("does not let a surface spell out its own refresh list", () => {
    // `kickProjectViewRefresh(["…"])` with a literal array is the shape that
    // let the sidebar and the Project screen refresh different things after
    // the same action.
    for (const file of CREATION_SURFACES) {
      expect(source(file)).not.toMatch(/kickProjectViewRefresh\(\s*\[/);
    }
  });
});
