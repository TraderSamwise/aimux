import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  AGENT_CREATION_REFRESH_VIEWS,
  AGENT_TOOL_CHOICES,
  WORKTREE_CREATION_REFRESH_VIEWS,
} from "./agent-create";

/**
 * Every surface that creates a worktree or an agent asks the same helpers.
 *
 * AGENTS.md "One Answer, Many Surfaces" asks for a test that compares the
 * surfaces rather than one test per surface: a per-surface test passes happily
 * while the surfaces disagree, which is exactly how this class survives. These
 * rules had already drifted once -- the two Project-screen panels kicked
 * different refresh lists for the same project.
 *
 * The surfaces are DISCOVERED, by who calls the creation API, rather than
 * listed: a hardcoded list silently stops covering the fourth surface someone
 * adds, which is the one most likely to get the rules wrong. And what is
 * asserted is which identifiers a surface references, not how its source is
 * spelled -- "Runtime Guardrails" rules out keying on spelling, and a regex
 * looking for `["claude"` passes happily on `['claude'` or a reordered list.
 */

const APP_ROOT = join(import.meta.dirname, "..");
const COMPONENTS = join(APP_ROOT, "components");

/** The api wrappers that actually create something. */
const CREATION_CALLS = ["spawnAgent", "createWorktree"] as const;

function componentSources(): { file: string; source: string }[] {
  return readdirSync(COMPONENTS)
    .filter((name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"))
    .map((name) => ({ file: name, source: readFileSync(join(COMPONENTS, name), "utf8") }));
}

/** Anything that imports a creation call from the api is a creation surface. */
function creationSurfaces(): { file: string; source: string }[] {
  return componentSources().filter(({ source }) =>
    CREATION_CALLS.some((call) => new RegExp(`\\b${call}\\b`).test(source)),
  );
}

describe("the surfaces that create things agree", () => {
  it("finds more than one, or this gate is measuring nothing", () => {
    const surfaces = creationSurfaces().map(({ file }) => file);
    expect(surfaces.length).toBeGreaterThan(1);
    // Named so a surface disappearing is visible rather than silently
    // shrinking what this file checks.
    expect(surfaces).toContain("CreateInProjectDialog.tsx");
    expect(surfaces).toContain("agent-create-panel.tsx");
    expect(surfaces).toContain("worktree-management-panel.tsx");
  });

  it("gets its rules from lib/agent-create", () => {
    for (const { file, source } of creationSurfaces()) {
      expect(source, `${file} must read the shared rules`).toContain('from "@/lib/agent-create"');
    }
  });

  it("names the shared constant wherever it offers a tool", () => {
    for (const { file, source } of creationSurfaces()) {
      // A surface that renders a tool choice at all must render the shared
      // list. One that creates only worktrees has no tools to offer.
      if (!/\btool\b/i.test(source)) continue;
      expect(source, `${file} must offer AGENT_TOOL_CHOICES`).toContain("AGENT_TOOL_CHOICES");
    }
  });

  it("names a shared refresh list wherever it refreshes", () => {
    for (const { file, source } of creationSurfaces()) {
      if (!source.includes("kickProjectViewRefresh")) continue;
      const usesShared =
        source.includes("AGENT_CREATION_REFRESH_VIEWS") ||
        source.includes("WORKTREE_CREATION_REFRESH_VIEWS");
      expect(usesShared, `${file} must use a shared refresh list`).toBe(true);
    }
  });

  it("asks the shared helper which worktrees it may offer", () => {
    for (const { file, source } of creationSurfaces()) {
      if (!source.includes("worktreePath") && !source.includes("removableWorktree")) continue;
      const usesShared =
        source.includes("creatableWorktreeChoices") || source.includes("removableWorktreeChoices");
      expect(usesShared, `${file} must not re-derive the worktree rule`).toBe(true);
    }
  });

  // The lists themselves, so a surface reading the right name still gets the
  // right answer.
  it("keeps the two refresh lists distinct", () => {
    expect(AGENT_CREATION_REFRESH_VIEWS).not.toEqual(WORKTREE_CREATION_REFRESH_VIEWS);
    expect(AGENT_TOOL_CHOICES.length).toBeGreaterThan(0);
  });
});
