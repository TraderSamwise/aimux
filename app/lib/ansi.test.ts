import { describe, expect, it } from "vitest";
import { ansiLineText, parseAnsiLines } from "./ansi";

const ESC = "\x1b[";

describe("parseAnsiLines", () => {
  it("splits a line into runs at each attribute change", () => {
    const [line] = parseAnsiLines(`plain ${ESC}1mbold${ESC}0m tail`);
    expect(line?.map((span) => span.text)).toEqual(["plain ", "bold", " tail"]);
    expect(line?.[1]?.style.fontWeight).toBe("bold");
    expect(line?.[2]?.style.fontWeight).toBeUndefined();
  });

  it("passes truecolor through, since the tool already chose the colour", () => {
    const [line] = parseAnsiLines(`${ESC}38;2;215;119;87mwarm`);
    expect(line?.[0]?.style.color).toBe("#d77757");
  });

  it("resolves the 256-colour cube and gray ramp", () => {
    expect(parseAnsiLines(`${ESC}38;5;196mx`)[0]?.[0]?.style.color).toBe("#ff0000");
    expect(parseAnsiLines(`${ESC}38;5;244mx`)[0]?.[0]?.style.color).toBe("#808080");
  });

  it("remaps the 16 base slots, which name a palette rather than a colour", () => {
    // Honouring these literally would paint the pane in the 1994 xterm defaults.
    const green = parseAnsiLines(`${ESC}32mok`)[0]?.[0]?.style.color;
    expect(green).toBe("#98c379");
    expect(parseAnsiLines(`${ESC}92mok`)[0]?.[0]?.style.color).not.toBe(green);
  });

  it("accepts the colon-separated spelling of an extended colour", () => {
    expect(parseAnsiLines(`${ESC}38:2:0:128:255mx`)[0]?.[0]?.style.color).toBe("#0080ff");
  });

  it("carries attributes across lines, since tmux emits them only where they change", () => {
    const lines = parseAnsiLines(`${ESC}31mred\nstill red${ESC}0m\nplain`);
    expect(lines[1]?.[0]?.style.color).toBe(lines[0]?.[0]?.style.color);
    expect(lines[2]?.[0]?.style.color).toBeUndefined();
  });

  it("renders dim as opacity so it composes with a foreground colour", () => {
    const style = parseAnsiLines(`${ESC}2;38;2;255;0;0mfaint`)[0]?.[0]?.style;
    expect(style?.opacity).toBeLessThan(1);
    expect(style?.color).toBe("#ff0000");
  });

  it("turns off individual attributes without clearing the rest", () => {
    const [line] = parseAnsiLines(`${ESC}1;4mboth${ESC}24mbold only`);
    expect(line?.[1]?.style.fontWeight).toBe("bold");
    expect(line?.[1]?.style.textDecorationLine).toBeUndefined();
  });

  it("swaps the two colours on inverse and swaps them back", () => {
    const [line] = parseAnsiLines(
      `${ESC}38;2;255;0;0m${ESC}48;2;0;0;255m${ESC}7mflip${ESC}27mback`,
    );
    expect(line?.[0]?.style.color).toBe("#0000ff");
    expect(line?.[0]?.style.backgroundColor).toBe("#ff0000");
    expect(line?.[1]?.style.color).toBe("#ff0000");
  });

  it("treats a bare reset as 0, the way terminals do", () => {
    const [line] = parseAnsiLines(`${ESC}1mbold${ESC}mplain`);
    expect(line?.[1]?.style.fontWeight).toBeUndefined();
  });

  it("keeps the text intact whatever the escapes did", () => {
    const raw = `${ESC}1m● ${ESC}0mBash(${ESC}38;5;244mls${ESC}0m)`;
    expect(ansiLineText(parseAnsiLines(raw)[0]!)).toBe("● Bash(ls)");
  });

  it("emits an empty run list for an empty line rather than a blank span", () => {
    expect(parseAnsiLines("a\n\nb")[1]).toEqual([]);
  });
});
