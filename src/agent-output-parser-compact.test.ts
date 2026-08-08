import { describe, expect, it } from "vitest";

import { parseAgentOutput } from "./agent-output-parser.js";
import { messagesFromParsedAgentOutput } from "./agent-transcript.js";

/**
 * Transcribed from a real Claude Code pane. The tool-result marker is U+23BF
 * (⎿), which is what the tool prints — not U+2514 (└), which only shows up in
 * box drawing.
 */
const COMPACT_PANE = [
  "❯ /compact",
  "  ⎿ Compacted (ctrl+o to see full summary)",
  "  ⎿ Referenced file packages/tealchart/src/ui/ChartCore.test.ts",
  "  ⎿ Read scripts/check-eslint-sync.mjs (156 lines)",
  "  ⎿ Skills restored (plan-execute)",
  "",
  "❯ do you have all the 4 epics still in context / scope?",
  "",
  "⏺ Listing 1 directory, running 1 shell command…",
  "  ⎿ $ git log --oneline origin/master..HEAD | cat",
].join("\n");

describe("a slash command followed by its tool results", () => {
  const messages = messagesFromParsedAgentOutput(parseAgentOutput(COMPACT_PANE, { tool: "claude" }));
  const users = messages.filter((message) => message.role === "user");

  it("keeps the two prompts as two separate user messages", () => {
    expect(users.map((message) => message.text)).toEqual([
      "/compact",
      "do you have all the 4 epics still in context / scope?",
    ]);
  });

  it("does not put the agent's tool results in the user's message", () => {
    const userText = users.map((message) => message.text).join("\n");
    expect(userText).not.toContain("Compacted");
    expect(userText).not.toContain("Referenced file");
    expect(userText).not.toContain("Skills restored");
    // The results belong to the agent; assert positively that they moved there
    // rather than only that they left, which a dropped line would also satisfy.
    const assistantText = messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.text)
      .join("\n");
    expect(assistantText).toContain("Compacted");
  });

  it("still lets a genuinely multi-line prompt run on", () => {
    const pasted = ["❯ first line of what I typed", "  second line of the same message"].join("\n");
    const typed = messagesFromParsedAgentOutput(parseAgentOutput(pasted, { tool: "claude" })).filter(
      (message) => message.role === "user",
    );
    expect(typed).toHaveLength(1);
    expect(typed[0]!.text).toContain("second line of the same message");
  });
});

/**
 * Claude Code paints a captioned rule as a footer and can leave it stale in the
 * pane long after the work it names has finished. It is chrome either way.
 */
describe("a rule with a caption in it", () => {
  const messagesFor = (pane: string) => messagesFromParsedAgentOutput(parseAgentOutput(pane, { tool: "claude" }));
  const textOf = (pane: string) =>
    messagesFor(pane)
      .map((message) => message.text)
      .join("\n");
  const footer = (rule: number) =>
    `${"\u2500".repeat(rule)} Review custom modules and signing sandbox changes ${"\u2500".repeat(rule)}`;

  it("keeps a stale captioned footer out of the transcript", () => {
    const text = textOf(["\u23fa Here is the answer you asked for.", "", footer(30)].join("\n"));
    expect(text).toContain("Here is the answer you asked for.");
    expect(text).not.toContain("Review custom modules");
  });

  it("catches the same footer on a narrow pane", () => {
    // The caption is a fixed 49 characters while the rules stretch to fill the
    // width, so anything proportional to line length passes here and fails wide.
    const text = textOf(["\u23fa Answer.", "", footer(5)].join("\n"));
    expect(text).not.toContain("Review custom modules");
  });

  it("does not swallow the prompt that follows a stale footer", () => {
    const pane = ["\u23fa Answer.", "", footer(30), "\u276f what about epic 2?"].join("\n");
    const users = messagesFor(pane).filter((message) => message.role === "user");
    expect(users.map((message) => message.text)).toEqual(["what about epic 2?"]);
  });

  it("leaves the collapsed approval header to the status rule that claims it", () => {
    // Guard against the titled-rule check swallowing it: a real assistant line
    // must survive alongside, so this cannot pass by producing no messages.
    const pane = [
      "\u23fa Real answer text.",
      "\u23fa " + "\u2500".repeat(40) + " Bash command",
      "  \u23bf $ echo hi",
    ].join("\n");
    const text = textOf(pane);
    expect(text).toContain("Real answer text.");
    expect(text).not.toContain("Bash command");
  });

  it("keeps a line with a rule on only one end", () => {
    // Chrome is rule-caption-rule. A rule on one side is somebody's content, and
    // requiring both ends is what tells them apart.
    const text = textOf(
      ["\u23fa Answer.", "", "\u2500".repeat(8) + " and this trailing note is real content"].join("\n"),
    );
    expect(text).toContain("this trailing note is real content");
  });

  it("keeps two queued prompts as two messages", () => {
    // Claude Code stacks queued messages as consecutive marker lines.
    const users = messagesFor(["\u276f first question", "\u276f second question"].join("\n")).filter(
      (message) => message.role === "user",
    );
    expect(users.map((message) => message.text)).toEqual(["first question", "second question"]);
  });

  it("still drops a captioned footer that follows a bare rule", () => {
    // The bare rule arms the demotion flag; if the captioned rule does not clear
    // it, the prompt underneath is demoted to status and the message vanishes.
    const pane = ["\u23fa Answer.", "\u2500".repeat(20), footer(20), "\u276f what about epic 2?"].join("\n");
    const users = messagesFor(pane).filter((message) => message.role === "user");
    expect(users.map((message) => message.text)).toEqual(["what about epic 2?"]);
  });
});
