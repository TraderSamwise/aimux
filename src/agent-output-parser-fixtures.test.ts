import { describe, expect, it } from "vitest";
import { AGENT_OUTPUT_PARSER_CONTRACT } from "./agent-output-parser-contract.js";
import { AGENT_OUTPUT_PARSER_FIXTURES } from "./agent-output-parser-fixtures.js";
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
    expect(AGENT_OUTPUT_PARSER_CONTRACT.invariants).toContain(
      "Suggested prompts and active input placeholders must not become prompt blocks.",
    );
    expect(AGENT_OUTPUT_PARSER_CONTRACT.invariants).toContain(
      "Feedback/rating prompts must not become prompt blocks.",
    );
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
