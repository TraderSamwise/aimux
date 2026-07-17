import { describe, expect, it } from "vitest";
import { parseKeys } from "./key-parser.js";

describe("parseKeys", () => {
  it("normalizes carriage return and line feed to enter", () => {
    expect(parseKeys("\r")).toEqual([{ char: "", name: "enter", shift: false, ctrl: false, alt: false, raw: "\r" }]);
    expect(parseKeys("\n")).toEqual([{ char: "", name: "enter", shift: false, ctrl: false, alt: false, raw: "\n" }]);
  });

  it("normalizes alt carriage return and alt line feed to alt+enter", () => {
    expect(parseKeys("\x1b\r")).toEqual([
      { char: "", name: "enter", shift: false, ctrl: false, alt: true, raw: "\x1b\r" },
    ]);
    expect(parseKeys("\x1b\n")).toEqual([
      { char: "", name: "enter", shift: false, ctrl: false, alt: true, raw: "\x1b\n" },
    ]);
  });

  it("keeps focus reports and following keys as separate events", () => {
    expect(parseKeys("\x1b[I\r").map((event) => event.name || event.char)).toEqual(["focusin", "enter"]);
  });
});
