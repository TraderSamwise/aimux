import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Overlay/dialog builders must be sized by the (cols, rows) the host passes in
// (the real tmux pane via getViewportSize()), never by process.stdout, which in
// the tmux dashboard runtime is the controlling tty and reports the 80 fallback.
// This guard keeps a new screen or dialog from silently reintroducing the bug.
const BUILDER_FILES = [
  "../screens/overlay-renderers.ts",
  "../screens/subscreen-renderers.ts",
  "../../multiplexer/tool-picker.ts",
  "../../multiplexer/dashboard-control.ts",
  "../../multiplexer/subscreens.ts",
  "../../multiplexer/worktrees.ts",
];

describe("overlay viewport contract", () => {
  it.each(BUILDER_FILES)("%s does not read process.stdout dimensions", (relPath) => {
    const source = readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), "utf8");
    expect(source).not.toMatch(/process\.stdout\??\.(columns|rows)/);
  });
});
