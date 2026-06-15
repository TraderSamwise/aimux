import { describe, expect, it } from "vitest";
import { composeTwoPane, stripAnsi } from "./text.js";

describe("composeTwoPane", () => {
  it("joins panes with the default pipe separator", () => {
    const [line] = composeTwoPane(["left"], ["right"], 80);
    expect(line).toContain(" │ ");
  });

  it("honors a custom separator of the same visible width", () => {
    const [line] = composeTwoPane(["left"], ["right"], 80, "   ");
    expect(line).not.toContain("│");
    const plain = stripAnsi(line);
    expect(plain).toContain("left");
    expect(plain).toContain("right");
  });
});
