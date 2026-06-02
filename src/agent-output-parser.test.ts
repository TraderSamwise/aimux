import { describe, expect, it } from "vitest";
import { parseAgentOutput } from "./agent-output-parser.js";

describe("parseAgentOutput", () => {
  it("keeps a trailing submitted Codex prompt without a response yet", () => {
    const raw = [
      "› write me a poem",
      "",
      "• Small lights wait in the screen at night,",
      "  a city built from thought and code.",
      "",
      "› Summarize recent commits",
      "",
      "  gpt-5.4 medium · 99% left · ~/cs/glyde-frontend/.aimux/worktrees/test3",
    ].join("\n");

    const parsed = parseAgentOutput(raw, { tool: "codex" });

    expect(parsed.blocks.map((block) => block.type)).toEqual(["prompt", "response", "prompt", "status"]);
    expect(parsed.blocks[0]?.text).toBe("write me a poem");
    expect(parsed.blocks[1]?.text).toContain("Small lights wait");
    expect(parsed.blocks[2]?.text).toBe("Summarize recent commits");
    expect(parsed.blocks[3]?.text).toContain("gpt-5.4 medium");
  });

  it("keeps Codex startup chrome out of chat responses", () => {
    const raw = [
      "╭─────────────────────────────────────────╮",
      "│ >_ OpenAI Codex (v0.133.0)              │",
      "│                                         │",
      "│ model:       loading   /model to change │",
      "│ directory:   ~/cs/glyde-frontend        │",
      "│ permissions: YOLO mode                  │",
      "╰─────────────────────────────────────────╯",
      "",
      "› reply exactly CODEX_PROTOCOL_OK",
      "",
      "  gpt-5.5 medium · ~/cs/glyde-frontend",
    ].join("\n");

    const parsed = parseAgentOutput(raw, { tool: "codex" });

    expect(parsed.blocks.map((block) => block.type)).toEqual(["meta", "prompt", "status"]);
    expect(parsed.blocks[0]?.text).toContain("OpenAI Codex");
    expect(parsed.blocks[1]?.text).toBe("reply exactly CODEX_PROTOCOL_OK");
    expect(parsed.blocks[2]?.text).toContain("gpt-5.5 medium");
  });

  it("parses Codex startup progress as status instead of a response", () => {
    const raw = [
      "› Run /review on my current changes",
      "",
      "  gpt-5.5 default · ~/cs/glyde-frontend",
      "",
      "• Starting MCP servers (1/4): chrome-devtools, codex_apps, openaiDeveloperDocs (0s • esc to interrupt)",
      "",
      "› reply exactly CODEX_SUBMIT_OK",
      "",
      "• CODEX_SUBMIT_OK",
    ].join("\n");

    const parsed = parseAgentOutput(raw, { tool: "codex" });

    expect(parsed.blocks.map((block) => block.type)).toEqual(["prompt", "status", "prompt", "response"]);
    expect(parsed.blocks[1]?.text).toContain("Starting MCP servers");
    expect(parsed.blocks[3]?.text).toBe("CODEX_SUBMIT_OK");
  });

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

  it("keeps wrapped Codex prompts together instead of turning continuations into replies", () => {
    const raw = [
      "› This is a very very long input message I am testing how this",
      "  message deal with wrapping etc wow so long very nice",
      "  don’t bother responding",
      "",
      "• Got it.",
    ].join("\n");

    const parsed = parseAgentOutput(raw, { tool: "codex" });

    expect(parsed.blocks.map((block) => block.type)).toEqual(["prompt", "response"]);
    expect(parsed.blocks[0]?.text).toBe(
      "This is a very very long input message I am testing how this\n" +
        "  message deal with wrapping etc wow so long very nice\n" +
        "  don’t bother responding",
    );
    expect(parsed.blocks[1]?.text).toBe("Got it.");
  });

  it("parses Codex spinner/progress rows as status instead of assistant chat", () => {
    const raw = [
      "› ui composer after restart - ignore",
      "",
      "• Ignored.",
      "",
      "* Sautéed for 5s",
      "",
      "› continue",
      "",
      "* Warping… (running stop hook · 11s · ↓ 16 tokens)",
      "",
      "  sam@MacBook-Pro-4 ~/cs/glyde-frontend feat/simplify-topbar-accounts ██░░░░5% Opus 4.7",
      "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
    ].join("\n");

    const parsed = parseAgentOutput(raw, { tool: "codex" });

    expect(parsed.blocks.map((block) => block.type)).toEqual(["prompt", "response", "status", "prompt", "status"]);
    expect(parsed.blocks[1]?.text).toBe("Ignored.");
    expect(parsed.blocks[2]?.text).toBe("Sautéed for 5s");
    expect(parsed.blocks[3]?.text).toBe("continue");
    expect(parsed.blocks[4]?.text).toContain("Warping…");
    expect(parsed.blocks[4]?.text).toContain("bypass permissions on");
  });

  it("keeps assistant markdown bullets with timing as response text", () => {
    const raw = [
      "› should I retry?",
      "",
      "• I'll wait for 5s before retrying.",
      "  Then I will check the result.",
    ].join("\n");

    const parsed = parseAgentOutput(raw, { tool: "codex" });

    expect(parsed.blocks.map((block) => block.type)).toEqual(["prompt", "response"]);
    expect(parsed.blocks[1]?.text).toBe("I'll wait for 5s before retrying.\n  Then I will check the result.");
  });

  it("keeps assistant star bullets with parentheticals as response text", () => {
    const raw = ["› summarize changes", "", "* Added tests (2 files)"].join("\n");

    const parsed = parseAgentOutput(raw, { tool: "codex" });

    expect(parsed.blocks.map((block) => block.type)).toEqual(["prompt", "response"]);
    expect(parsed.blocks[1]?.text).toBe("* Added tests (2 files)");
  });

  it("parses Claude spinner/progress rows as status instead of assistant chat", () => {
    const raw = [
      "❯ hi",
      "",
      "⏺ Hi! What can I help you with?",
      "",
      "✻ Baked for 3s",
      "",
      "────────────────────────────────────────────────────────────────────────────────────────────────",
      "❯ ",
      "────────────────────────────────────────────────────────────────────────────────────────────────",
      "  sam@MacBook-Pro-4 ~/cs/glyde-frontend feat/simplify-topbar-accounts ██░░░░5% Opus 4.7",
      "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
    ].join("\n");

    const parsed = parseAgentOutput(raw, { tool: "claude" });

    expect(parsed.blocks.map((block) => block.type)).toEqual(["prompt", "response", "status"]);
    expect(parsed.blocks[1]?.text).toBe("Hi! What can I help you with?");
    expect(parsed.blocks[2]?.text).toContain("Baked for 3s");
    expect(parsed.blocks[2]?.text).toContain("bypass permissions on");
  });
});
