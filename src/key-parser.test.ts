import { describe, expect, it } from "vitest";
import { parseKeys } from "./key-parser.js";

describe("parseKeys", () => {
  it("distinguishes enter from ctrl+j", () => {
    expect(parseKeys("\r")).toEqual([{ char: "", name: "enter", shift: false, ctrl: false, alt: false, raw: "\r" }]);
    expect(parseKeys("\n")).toEqual([{ char: "", name: "j", shift: false, ctrl: true, alt: false, raw: "\n" }]);
  });

  it("preserves alt+enter and alt+ctrl+j separately", () => {
    expect(parseKeys("\x1b\r")).toEqual([
      { char: "", name: "enter", shift: false, ctrl: false, alt: true, raw: "\x1b\r" },
    ]);
    expect(parseKeys("\x1b\n")).toEqual([{ char: "", name: "j", shift: false, ctrl: true, alt: true, raw: "\x1b\n" }]);
  });
});
