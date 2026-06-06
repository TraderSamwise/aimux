import { describe, expect, it } from "vitest";
import { AGENT_OUTPUT_PARSER_CONTRACT } from "./agent-output-parser-contract.js";
import { AGENT_OUTPUT_PARSER_FIXTURES } from "./agent-output-parser-fixtures.js";
import { getParserFixture } from "./agent-output-parser-test-utils.js";
import { parseAgentOutput } from "./agent-output-parser.js";

describe("agent output parser contract", () => {
  it("documents the supported block types and critical invariants", () => {
    expect(AGENT_OUTPUT_PARSER_CONTRACT.blockTypes.map((block) => block.type)).toEqual([
      "prompt",
      "response",
      "status",
      "meta",
      "raw",
    ]);
    expect(AGENT_OUTPUT_PARSER_CONTRACT.invariants).toEqual([
      "Suggested prompts and active input placeholders must not become prompt blocks.",
      "Feedback/rating prompts must not become prompt blocks.",
      "A prompt block must represent user text that was submitted to the agent, not text merely visible in the terminal input row.",
      "Assistant text stays response text even when it contains prompt-looking markers, quotes, bullets, fences, or paths.",
      "Startup banners, footer/status lines, progress rows, and permission hints must not become response blocks.",
      "Activity/progress rows must remain status text with their exact activity wording preserved.",
      "Parsing the same complete transcript repeatedly should produce the same block sequence.",
    ]);
  });
});

describe("agent output parser fixtures", () => {
  for (const fixture of AGENT_OUTPUT_PARSER_FIXTURES) {
    it(`parses ${fixture.name}`, () => {
      const parsed = parseAgentOutput(fixture.raw, { tool: fixture.tool });

      expect(parsed.blocks.map((block) => block.type)).toEqual(fixture.expected.map((block) => block.type));
      expect(parsed.parser).toEqual({
        tool: fixture.tool,
        version: 1,
        confidence: "heuristic",
      });

      fixture.expected.forEach((expected, index) => {
        const actual = parsed.blocks[index];
        expect(actual?.type).toBe(expected.type);
        for (const text of expected.includes) {
          expect(actual?.text).toContain(text);
        }
        for (const text of expected.excludes ?? []) {
          expect(actual?.text).not.toContain(text);
        }
      });

      for (const text of fixture.invariants?.noPromptIncludes ?? []) {
        expect(
          parsed.blocks.some((block) => block.type === "prompt" && block.text.includes(text)),
          `${fixture.name}: prompt block must not contain ${JSON.stringify(text)}`,
        ).toBe(false);
      }

      expect(parseAgentOutput(fixture.raw, { tool: fixture.tool }).blocks).toEqual(parsed.blocks);
    });
  }
});

describe("agent output parser tool inference", () => {
  it("infers Codex mode when callers omit tool context", () => {
    const fixture = getParserFixture("codex-live-startup-suggestion-loop");

    const parsed = parseAgentOutput(fixture.raw);

    expect(parsed.parser.tool).toBe("codex");
    expect(parsed.blocks.map((block) => block.type)).toEqual(fixture.expected.map((block) => block.type));
    const hasSuggestionPrompt = parsed.blocks.some(
      (block) => block.type === "prompt" && block.text.includes("Explain this codebase"),
    );
    expect(hasSuggestionPrompt).toBe(false);
  });

  it("infers Claude mode when callers omit tool context", () => {
    const fixture = getParserFixture("claude-real-prompt-that-matches-codex-suggestion");

    const parsed = parseAgentOutput(fixture.raw);

    expect(parsed.parser.tool).toBe("claude");
    expect(parsed.blocks.map((block) => block.type)).toEqual(fixture.expected.map((block) => block.type));
  });

  it("preserves explicit non-unknown tool context", () => {
    const fixture = getParserFixture("codex-live-startup-suggestion-loop");

    const parsed = parseAgentOutput(fixture.raw, { tool: "claude" });

    expect(parsed.parser.tool).toBe("claude");
  });

  it("does not infer from casual tool mentions inside assistant text", () => {
    const raw = [
      "• Claude Code and OpenAI Codex both support terminal workflows.",
      "",
      "  I can compare them if useful.",
    ].join("\n");

    const parsed = parseAgentOutput(raw);

    expect(parsed.parser.tool).toBe("unknown");
    expect(parsed.blocks.map((block) => block.type)).toEqual(["response"]);
  });

  it("does not infer when both tool chrome signatures are present", () => {
    const raw = [
      "│ >_ OpenAI Codex (v0.136.0) │",
      "Claude Code",
      "› Explain this codebase",
      "  gpt-5.5 medium · ~/workspace/project",
    ].join("\n");

    const parsed = parseAgentOutput(raw);

    expect(parsed.parser.tool).toBe("unknown");
  });
});
