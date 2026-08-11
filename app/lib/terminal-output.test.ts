import { describe, expect, it } from "vitest";
import { ansiLineText } from "./ansi";
import {
  formatPlainTextForDisplay,
  formatRichTextSpansForDisplay,
  formatTerminalOutputForDisplay,
} from "./terminal-output";

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

describe("formatPlainTextForDisplay", () => {
  it("caps and collapses divider runs in chat text", () => {
    const divider = "-".repeat(80);

    expect(
      formatPlainTextForDisplay(["done", divider, divider, "next"].join("\n"), {
        dividerWidth: 28,
      }),
    ).toBe(["done", "-".repeat(28), "next"].join("\n"));
  });

  it("preserves short markdown separators in chat text", () => {
    expect(formatPlainTextForDisplay("front\n---\nmatter")).toBe("front\n---\nmatter");
  });

  it("adds invisible break opportunities to long chat tokens", () => {
    expect(
      formatPlainTextForDisplay(
        "https://tealstreet-next-crsjkcxey-tealstreet-b565b19f.vercel.app",
        {
          softWrapColumn: 18,
        },
      ),
    ).toBe("https://tealstreet-\u200Bnext-crsjkcxey-\u200Btealstreet-b565b19f\u200B.vercel.app");
  });
});

describe("formatRichTextSpansForDisplay", () => {
  it("caps and collapses divider spans without dropping nearby colour", () => {
    const divider = "-".repeat(80);

    expect(
      formatRichTextSpansForDisplay(
        [
          { text: "done", foreground: { model: "rgb", value: "#98c379" } },
          { text: "\n" },
          { text: divider, foreground: { model: "rgb", value: "#808080" } },
          { text: "\n" },
          { text: divider, foreground: { model: "rgb", value: "#808080" } },
          { text: "\nnext", marks: ["bold"] },
        ],
        { dividerWidth: 10 },
      ),
    ).toEqual([
      { text: "done", foreground: { model: "rgb", value: "#98c379" } },
      { text: "\n" },
      { text: "-".repeat(10), foreground: { model: "rgb", value: "#808080" } },
      { text: "\n" },
      { text: "next", marks: ["bold"] },
    ]);
  });

  it("adds invisible break opportunities without dropping rich span colours", () => {
    expect(
      formatRichTextSpansForDisplay(
        [
          {
            text: "tealstreet-next-crsjkcxey-tealstreet-b565b19f.vercel.app",
            foreground: { model: "rgb", value: "#56b6c2" },
          },
        ],
        { softWrapColumn: 18 },
      ),
    ).toEqual([
      {
        text: "tealstreet-next-\u200Bcrsjkcxey-tealstreet\u200B-b565b19f.vercel\u200B.app",
        foreground: { model: "rgb", value: "#56b6c2" },
      },
    ]);
  });
});
