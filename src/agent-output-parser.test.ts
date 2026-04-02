import { describe, expect, it } from "vitest";
import { parseAgentOutput } from "./agent-output-parser.js";

describe("parseAgentOutput", () => {
  it("splits Claude prompt, response, and footer status from a live pane snapshot", () => {
    const raw = [
      "  the estimate was never wrong.",
      "  The question was just incomplete.",
      '  "How long will this take?"',
      "  assumes the ground beneath your feet",
      "",
      "  is solid.",
      "",
      "  It never is.",
      "",
      "  You ship it on day five",
      "  and no one says a thing,",
      "  because it's done, and done is done,",
      "  and that's the offering.",
      "",
      "❯ what is your favorite food",
      "",
      "⏺ I don't eat, but if I did, I'd like to think I'd be a ramen person. Something about a long-running process",
      "  producing a rich, layered result feels on brand.",
      "",
      "  What about you?",
      "",
      "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
      "❯ ",
      "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
      "  sam@MacBook-Pro-4 ~/cs/glyde-frontend/.aimux/worktrees/test3 test3 ██░░░░░░░░░░Image in cChecking for u",
      "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
    ].join("\n");

    const parsed = parseAgentOutput(raw, { tool: "claude" });

    expect(parsed.blocks.map((block) => block.type)).toEqual(["response", "prompt", "response", "status"]);
    expect(parsed.blocks[0]?.text).toContain("the estimate was never wrong.");
    expect(parsed.blocks[0]?.text).toContain("and that's the offering.");
    expect(parsed.blocks[1]?.text).toBe("what is your favorite food");
    expect(parsed.blocks[2]?.text).toContain("I don't eat, but if I did");
    expect(parsed.blocks[2]?.text).toContain("What about you?");
    expect(parsed.blocks[3]?.text).toContain("sam@MacBook-Pro-4 ~/cs/glyde-frontend/.aimux/worktrees/test3");
    expect(parsed.blocks[3]?.text).toContain("bypass permissions on (shift+tab to cycle)");
  });

  it("parses Claude response markers and ignores an empty visible prompt", () => {
    const raw = [
      "❯ what is your favorite food",
      "",
      "⏺ I don't eat, but if I did, I'd like to think I'd be a ramen person.",
      "",
      "  What about you?",
      "",
      "❯ ",
      "  sam@host ~/repo/test3 test3 Image",
      "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
    ].join("\n");

    const parsed = parseAgentOutput(raw, { tool: "claude" });

    expect(parsed.blocks.map((block) => block.type)).toEqual(["prompt", "response", "status"]);
    expect(parsed.blocks[0]?.text).toBe("what is your favorite food");
    expect(parsed.blocks[1]?.text).toContain("What about you?");
    expect(parsed.blocks[2]?.text).toContain("sam@host ~/repo/test3");
  });
});
