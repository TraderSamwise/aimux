import { describe, expect, it } from "vitest";
import { formatTerminalOutputForDisplay } from "./terminal-output";

describe("formatTerminalOutputForDisplay", () => {
  it("collapses wrapped divider runs into one capped divider", () => {
    const divider = "────────────────────────────────────────────────────────────────";
    const output = ["before", divider, divider, "❯ write me a poem"].join("\n");

    expect(formatTerminalOutputForDisplay(output, { dividerWidth: 20 })).toBe(
      ["before", "────────────────────", "❯ write me a poem"].join("\n"),
    );
  });

  it("preserves normal terminal text and short separators", () => {
    const output = ["❯ hi", "-----", "⏺ Hey! What would you like to work on?"].join("\n");

    expect(formatTerminalOutputForDisplay(output)).toBe(output);
  });

  it("preserves indentation when capping divider lines", () => {
    const output = "  ===============================================================";

    expect(formatTerminalOutputForDisplay(output, { dividerWidth: 8 })).toBe("  ========");
  });
});
