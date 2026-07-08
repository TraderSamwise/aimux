import { describe, expect, it } from "vitest";
import { userFacingErrorLines, userFacingErrorMessage } from "./error-display.js";

describe("user-facing errors", () => {
  it("collapses raw tmux command failures before they reach dashboard modals", () => {
    const lines = userFacingErrorLines(
      new Error("Command failed: tmux new-window env -i OPENAI_API_KEY=sk-real SECRET_TOKEN=abc"),
    );

    expect(lines).toEqual([
      "tmux failed while updating the managed runtime.",
      "Run aimux restart if it does not recover automatically.",
    ]);
    expect(lines.join("\n")).not.toContain("sk-real");
    expect(lines.join("\n")).not.toContain("SECRET_TOKEN");
  });

  it("redacts sensitive assignments in ordinary messages", () => {
    expect(userFacingErrorMessage(new Error("failed TOKEN=abc ok=1"))).toBe("failed TOKEN=<redacted> ok=1");
  });
});
