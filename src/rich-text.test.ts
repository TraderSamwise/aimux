import { describe, expect, it } from "vitest";

import { parseSgrRichTextLines, richTextLineText, richTextText } from "./rich-text.js";

const ESC = "\x1b[";

describe("parseSgrRichTextLines", () => {
  it("splits text into structured runs without raw escapes", () => {
    const [line] = parseSgrRichTextLines(`plain ${ESC}1mbold${ESC}0m tail`);

    expect(line).toEqual([{ text: "plain " }, { text: "bold", marks: ["bold"] }, { text: " tail" }]);
  });

  it("projects truecolor and 256-color escapes into rgb colors", () => {
    const [truecolor] = parseSgrRichTextLines(`${ESC}38;2;215;119;87mwarm`);
    const [gray] = parseSgrRichTextLines(`${ESC}38;5;244mgray`);

    expect(truecolor?.[0]?.foreground).toEqual({ model: "rgb", value: "#d77757" });
    expect(gray?.[0]?.foreground).toEqual({ model: "rgb", value: "#808080" });
  });

  it("carries attributes across lines until reset", () => {
    const lines = parseSgrRichTextLines(`${ESC}31mred\nstill red${ESC}0m\nplain`);

    expect(lines[1]?.[0]?.foreground).toEqual(lines[0]?.[0]?.foreground);
    expect(lines[2]?.[0]?.foreground).toBeUndefined();
  });

  it("keeps marks and inverse colors structured", () => {
    const [line] = parseSgrRichTextLines(`${ESC}1;3;4;38;2;255;0;0m${ESC}48;2;0;0;255m${ESC}7mflip`);

    expect(line?.[0]).toEqual({
      text: "flip",
      marks: ["bold", "italic", "underline"],
      foreground: { model: "rgb", value: "#0000ff" },
      background: { model: "rgb", value: "#ff0000" },
    });
  });

  it("recovers plain text from parsed lines", () => {
    const lines = parseSgrRichTextLines(`${ESC}1m● ${ESC}0mBash(${ESC}38;5;244mls${ESC}0m)`);

    expect(richTextLineText(lines[0]!)).toBe("● Bash(ls)");
    expect(richTextText(lines)).toBe("● Bash(ls)");
  });
});
