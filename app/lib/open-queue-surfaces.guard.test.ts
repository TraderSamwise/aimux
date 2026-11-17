import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// No surface decides for itself whether a task is still open.
//
// `isOpenTask` in `@/lib/project-observability` answers it, over the full set
// of terminal statuses: done, complete, completed, closed, cancelled,
// canceled, abandoned. The coordination screen's open queue carries live claim
// and complete controls, and a hand-rolled list beside it missed five of those
// seven -- so finished tasks were offered as work still waiting, with buttons.
//
// A per-screen test would not catch the next copy, so this is a search.
const SCREEN_PATHS = [
  join(__dirname, "..", "app", "(main)", "(tabs)", "coordination", "index.tsx"),
];

// A status list spelled out next to a filter is the shape to refuse.
const HAND_ROLLED_TERMINAL_LIST = /status\s*!==\s*["'](?:done|canceled|cancelled|closed)["']/i;

describe("the open task queue", () => {
  for (const path of SCREEN_PATHS) {
    const source = readFileSync(path, "utf8");

    it(`asks the shared rule in ${path.split("/").slice(-2).join("/")}`, () => {
      expect(source).toContain("isOpenTask");
    });

    it(`does not spell out its own terminal statuses in ${path.split("/").slice(-2).join("/")}`, () => {
      expect(source).not.toMatch(HAND_ROLLED_TERMINAL_LIST);
    });
  }
});
