import { describe, expect, it } from "vitest";
import { createAgentOutputParserHarness } from "./agent-output-parser-harness.js";
import { getParserFixture } from "./agent-output-parser-test-utils.js";

describe("agent output parser harness", () => {
  it("parses dummy Claude and Codex live panes through the runtime read path", async () => {
    const claude = getParserFixture("claude-multi-unit-activity-status");
    const codex = getParserFixture("codex-repeated-template-suggestion");
    const harness = createAgentOutputParserHarness([
      {
        id: "claude-dummy",
        tool: claude.tool,
        output: claude.raw,
      },
      {
        id: "codex-dummy",
        tool: codex.tool,
        output: codex.raw,
      },
    ]);

    const [claudeRead, codexRead] = await harness.readAll(-120);

    expect(claudeRead?.sessionId).toBe("claude-dummy");
    expect(claudeRead?.startLine).toBe(-120);
    expect(claudeRead?.parsed.parser.tool).toBe("claude");
    expect(claudeRead?.parsed.blocks.map((block) => block.type)).toEqual(["response", "status"]);
    expect(claudeRead?.parsed.blocks.find((block) => block.type === "status")?.text).toContain("Cooked for 1m 2s");

    expect(codexRead?.sessionId).toBe("codex-dummy");
    expect(codexRead?.parsed.parser.tool).toBe("codex");
    expect(codexRead?.parsed.blocks.map((block) => block.type)).toEqual(["meta", "status"]);
    expect(codexRead?.parsed.blocks.some((block) => block.type === "prompt")).toBe(false);
    expect(codexRead?.parsed.blocks.find((block) => block.type === "status")?.text).toContain("Implement {feature}");
  });

  it("parses mined live-pane edge cases through the runtime read path", async () => {
    const claude = getParserFixture("claude-live-tool-action-rows");
    const codex = getParserFixture("codex-live-startup-suggestion-loop");
    const harness = createAgentOutputParserHarness([
      {
        id: "claude-actions",
        tool: claude.tool,
        output: claude.raw,
      },
      {
        id: "codex-startup-loop",
        tool: codex.tool,
        output: codex.raw,
      },
    ]);

    const [claudeRead, codexRead] = await harness.readAll(-200);

    expect(claudeRead?.parsed.blocks.map((block) => block.type)).toEqual(["response", "status", "response"]);
    expect(claudeRead?.parsed.blocks[1]?.text).toContain("Bash(cd");
    expect(claudeRead?.parsed.blocks[1]?.text).toContain("Read 2 files");
    expect(claudeRead?.parsed.blocks[2]?.text).toContain("All checks are green");

    expect(codexRead?.parsed.blocks.map((block) => block.type)).toEqual(["meta", "status"]);
    expect(codexRead?.parsed.blocks.some((block) => block.type === "prompt")).toBe(false);
    expect(codexRead?.parsed.blocks[1]?.text).toContain("Explain this codebase");
    expect(codexRead?.parsed.blocks[1]?.text).toContain("Starting MCP servers");
  });

  it("updates a dummy pane snapshot without recreating the harness", async () => {
    const harness = createAgentOutputParserHarness([
      {
        id: "codex-live",
        tool: "codex",
        output: ["› Implement {feature}", "", "  gpt-5.5 medium · ~/workspace/project/.aimux/worktrees/fuzz"].join(
          "\n",
        ),
      },
    ]);

    const draftRead = await harness.read("codex-live");
    expect(draftRead.parsed.blocks.map((block) => block.type)).toEqual(["status"]);
    expect(draftRead.parsed.blocks[0]?.text).toContain("Implement {feature}");

    harness.setOutput(
      "codex-live",
      [
        "› USER_SENTINEL_live ask for work",
        "",
        "• RESPONSE_SENTINEL_live completed the work.",
        "",
        "* Cooked for 1m 2s · STATUS_SENTINEL_live",
      ].join("\n"),
    );

    const updatedRead = await harness.read("codex-live");
    expect(updatedRead.parsed.blocks.map((block) => block.type)).toEqual(["prompt", "response", "status"]);
    expect(updatedRead.parsed.blocks.find((block) => block.type === "prompt")?.text).toContain("USER_SENTINEL_live");
    expect(updatedRead.parsed.blocks.find((block) => block.type === "response")?.text).toContain(
      "RESPONSE_SENTINEL_live",
    );
    expect(updatedRead.parsed.blocks.find((block) => block.type === "status")?.text).toContain("STATUS_SENTINEL_live");
  });

  it("fails loudly when a test tries to update an unknown dummy session", () => {
    const harness = createAgentOutputParserHarness([]);

    expect(() => harness.setOutput("missing", "anything")).toThrow('Unknown parser harness session "missing"');
  });
});
