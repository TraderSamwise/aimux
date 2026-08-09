import { describe, expect, it } from "vitest";
import { ansiLineText } from "./ansi";
import { formatTerminalOutputForDisplay } from "./terminal-output";

const plain = (output: string, dividerWidth?: number) =>
  formatTerminalOutputForDisplay(output, dividerWidth === undefined ? {} : { dividerWidth }).map(
    ansiLineText,
  );

describe("formatTerminalOutputForDisplay", () => {
  it("collapses wrapped divider runs into one capped divider", () => {
    const divider = "────────────────────────────────────────────────────────────────";
    const output = ["before", divider, divider, "❯ write me a poem"].join("\n");

    expect(plain(output, 20)).toEqual(["before", "────────────────────", "❯ write me a poem"]);
  });

  it("preserves normal terminal text and short separators", () => {
    const lines = ["❯ hi", "-----", "⏺ Hey! What would you like to work on?"];

    expect(plain(lines.join("\n"))).toEqual(lines);
  });

  it("preserves indentation when capping divider lines", () => {
    expect(plain("  ===============================================================", 8)).toEqual([
      "  ========",
    ]);
  });

  it("keeps the pane's colours on the text it passes through", () => {
    const [line] = formatTerminalOutputForDisplay("\x1b[38;2;120;200;90mgreen\x1b[0m rest");

    expect(line?.[0]).toEqual({ text: "green", style: { color: "#78c85a" } });
    expect(line?.[1]?.style.color).toBeUndefined();
  });

  it("keeps a capped divider's colour, so a rule does not turn plain when cut", () => {
    const divider = `\x1b[38;5;244m${"─".repeat(64)}`;
    const [line] = formatTerminalOutputForDisplay(divider, { dividerWidth: 8 });

    expect(line).toHaveLength(1);
    expect(line?.[0]?.text).toBe("────────");
    expect(line?.[0]?.style.color).toBe("#808080");
  });

  it("measures dividers on the text, not the escapes padding it", () => {
    // A short rule wrapped in colour is still short; counting bytes would have
    // pushed it past the threshold and capped a line that is not a divider.
    expect(plain("\x1b[31m-----\x1b[0m", 8)).toEqual(["-----"]);
  });
});
