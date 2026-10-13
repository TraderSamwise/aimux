import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Whatever renders an unread count asks `unreadBadgeLabel` how to write it.
 *
 * `unread-badge.test.ts` gates the rule; nothing gated its USE. Re-inlining
 * the cap in the component as `count > 50 ? "50+"` passed the entire app
 * suite, which is the same hole the rule was extracted to close -- and this is
 * the surface the TUI badge was built to match, so a drift here is a drift
 * between the two clients.
 *
 * Surfaces are DISCOVERED, by who reads the count, rather than listed: a
 * hardcoded list silently stops covering the second component someone adds.
 * What is asserted is which identifier the surface references, not how its
 * source is spelled -- "Runtime Guardrails" rules out keying on spelling, and
 * a regex hunting for `99` passes on any other number.
 */

const APP_ROOT = join(import.meta.dirname, "..");

/** The field the project service publishes the count in. */
const COUNT_FIELD = "notificationUnreadCount";

/**
 * Source with comments removed.
 *
 * Without this the gate passed on a mutation that re-inlined the cap, because
 * the identifier still appeared in the comment above the component explaining
 * which helper it uses. A mention is not a use.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function sourcesIn(dir: string): { file: string; source: string }[] {
  return readdirSync(join(APP_ROOT, dir), { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.includes(".test."),
    )
    .map((entry) => ({
      file: `${dir}/${entry.name}`,
      source: readFileSync(join(APP_ROOT, dir, entry.name), "utf8"),
    }));
}

/** Anything that reads the published count is rendering it for someone. */
function unreadSurfaces(): { file: string; source: string }[] {
  return [...sourcesIn("components"), ...sourcesIn("lib")].filter(
    ({ file, source }) =>
      new RegExp(`\\b${COUNT_FIELD}\\b`).test(source) && !file.endsWith("unread-badge.ts"),
  );
}

describe("the surfaces that render an unread count", () => {
  it("finds at least one, or this gate is measuring nothing", () => {
    const surfaces = unreadSurfaces().map(({ file }) => file);
    expect(surfaces.length).toBeGreaterThan(0);
    // Named so the badge moving out of this file is visible rather than
    // silently shrinking what is checked.
    expect(surfaces).toContain("components/WorktreeDashboard.tsx");
  });

  it("asks the shared helper how to write the count", () => {
    for (const { file, source } of unreadSurfaces()) {
      const code = withoutComments(source);
      // A surface that only forwards the field renders no label.
      if (!/badge/i.test(code)) continue;
      expect(code, `${file} must call unreadBadgeLabel`).toContain("unreadBadgeLabel(");
      expect(code, `${file} must import it from the shared module`).toContain(
        'from "@/lib/unread-badge"',
      );
    }
  });
});
