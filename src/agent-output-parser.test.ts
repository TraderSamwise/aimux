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

  it("keeps Claude feedback survey input out of chat prompts", () => {
    const raw = [
      "⏺ There's our 2 at the top, then ~30 sequential Pine-related PRs (#584-616) — looks like autonomous-agent churn on",
      "  Pinescript compatibility.",
      "",
      "  Want a closer look at any particular one, or a diff stat to see what files changed?",
      "",
      "* Churned for 15s",
      "",
      "  4 tasks (3 done, 1 in progress, 0 open)",
      "  ✓ Soft-archive retiring channels (lock + pinned redirect)",
      "  ✓ Apply target category structure",
      "  ■ Refresh #start-here welcome post via webhook",
      "  ✓ Move non-secret Discord/Slack channel config out of .env",
      "",
      "• How is Claude doing this session? (optional)",
      "  1: Bad     2: Fine    3: Good    0: Dismiss",
      "",
      "────────────────────────────────────────────────────────────────────────────────────────────────",
      "❯ no that's fine, what's next?",
      "────────────────────────────────────────────────────────────────────────────────────────────────",
      "  sam@MacBook-Pro-4 ~/cs/tealstreet-next master ██░░░░38% Opus 4.7",
      "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
    ].join("\n");

    const parsed = parseAgentOutput(raw, { tool: "claude" });

    expect(parsed.blocks.map((block) => block.type)).toEqual(["response", "status"]);
    expect(parsed.blocks[0]?.text).toContain("Want a closer look");
    expect(parsed.blocks[1]?.text).toContain("How is Claude doing this session?");
    expect(parsed.blocks[1]?.text).toContain("no that's fine, what's next?");
  });

  it("keeps Codex active input suggestions out of chat prompts", () => {
    const raw = [
      "• PR #5914 is merged.",
      "",
      "  CodeRabbit loop completed:",
      "",
      "  - CodeRabbit status: green.",
      "  - Copilot left 5 comments; fixed them in 52826d48e9 and replied to each thread.",
      "  - CI passed before merge.",
      "",
      "  Worktree is clean.",
      "",
      "- Worked for 20m 16s",
      "────────────────────────────────────────────────────────────────────────────────────────────────",
      "› Find and fix a bug in @filename",
      "────────────────────────────────────────────────────────────────────────────────────────────────",
      "  gpt-5.5 medium · ~/cs/tealstreet-next · Main [default]",
    ].join("\n");

    const parsed = parseAgentOutput(raw, { tool: "codex" });

    expect(parsed.blocks.map((block) => block.type)).toEqual(["response", "status"]);
    expect(parsed.blocks[0]?.text).toContain("PR #5914 is merged.");
    expect(parsed.blocks[1]?.text).toContain("Find and fix a bug in @filename");
  });

  it("keeps Codex active input followed by the footer out of chat prompts", () => {
    const raw = [
      "› can you see this? Attached image files: - Screenshot.png (image/png, 120484 bytes): /Users/sam/cs/glyde-frontend/.aimux/attachments/att_3cbe0ace620a4e54aec6b885062ad615.png",
      "",
      "• Working (4s • esc to interrupt)",
      "",
      "› Explain this codebase",
      "",
      "  gpt-5.5 medium · ~/cs/glyde-frontend",
    ].join("\n");

    const parsed = parseAgentOutput(raw, { tool: "codex" });

    expect(parsed.blocks.map((block) => block.type)).toEqual(["prompt", "status"]);
    expect(parsed.blocks[0]?.text).toContain("can you see this?");
    expect(parsed.blocks[1]?.text).toContain("Explain this codebase");
  });

  it("keeps completed-state Codex suggested prompts out of chat prompts", () => {
    const raw = [
      "• A spiral wakes in ember light,",
      "  pink at the edge of morning.",
      "",
      "› Explain this codebase",
      "",
      "  gpt-5.5 medium · ~/cs/glyde-frontend",
    ].join("\n");

    const parsed = parseAgentOutput(raw, { tool: "codex" });

    expect(parsed.blocks.map((block) => block.type)).toEqual(["response", "status"]);
    expect(parsed.blocks[0]?.text).toContain("A spiral wakes");
    expect(parsed.blocks[1]?.text).toContain("Explain this codebase");
  });

  it("keeps non-Codex prompts that match Codex suggestions", () => {
    const raw = ["⏺ Ready when you are.", "", "❯ Explain this codebase", "", "  claude · ~/cs/glyde-frontend"].join(
      "\n",
    );

    const parsed = parseAgentOutput(raw, { tool: "claude" });

    expect(parsed.blocks.map((block) => block.type)).toEqual(["response", "prompt", "status"]);
    expect(parsed.blocks[1]?.text).toBe("Explain this codebase");
  });
});
