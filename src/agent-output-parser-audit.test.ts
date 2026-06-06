import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditAgentOutputParserCorpus } from "./agent-output-parser-audit.js";

const tempDirs: string[] = [];

const makeTempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "aimux-parser-audit-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("auditAgentOutputParserCorpus", () => {
  it("reports suspicious status text that still parses as an assistant response", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "claude-test.jsonl"),
      `${JSON.stringify({
        type: "response",
        content: "Bash(terminal-notifier -title ClaudeCode) appeared as visible assistant prose",
      })}\n`,
    );

    const summary = auditAgentOutputParserCorpus({ historyDirs: [dir] });

    expect(summary.scanned).toBe(1);
    expect(summary.countsByFlag["status-leak-response"]).toBe(1);
    expect(summary.findings).toEqual([
      expect.objectContaining({
        source: join(dir, "claude-test.jsonl"),
        recordIndex: 0,
        tool: "claude",
        blockType: "response",
        flags: ["status-leak-response"],
      }),
    ]);
  });

  it("does not flag prose or code samples that only mention agent chrome terms", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "codex-test.jsonl"),
      `${JSON.stringify({
        type: "response",
        content: [
          "This regression fixture compares OpenAI Codex and Claude Code in normal assistant prose.",
          "",
          'const sample = "OpenAI Codex appears in parser test data";',
        ].join("\n"),
      })}\n`,
    );

    const summary = auditAgentOutputParserCorpus({ historyDirs: [dir] });

    expect(summary.scanned).toBe(1);
    expect(summary.countsByFlag["status-leak-response"]).toBe(0);
    expect(summary.findings).toEqual([]);
  });

  it("does not flag Codex chrome that the parser already classifies as metadata", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "codex-test.jsonl"),
      `${JSON.stringify({
        type: "response",
        content: "Here is the leaked pane header:\n│ >_ OpenAI Codex (v0.136.0) │",
      })}\n`,
    );

    const summary = auditAgentOutputParserCorpus({ historyDirs: [dir] });

    expect(summary.scanned).toBe(1);
    expect(summary.countsByFlag["status-leak-response"]).toBe(0);
    expect(summary.findings).toEqual([]);
  });

  it("does not flag prose that mentions tool-row examples", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "claude-test.jsonl"),
      `${JSON.stringify({
        type: "response",
        content: "Bash(cd /tmp) is a common shell shape, and Read 2 files is only an example here.",
      })}\n`,
    );

    const summary = auditAgentOutputParserCorpus({ historyDirs: [dir] });

    expect(summary.scanned).toBe(1);
    expect(summary.countsByFlag["status-leak-response"]).toBe(0);
    expect(summary.findings).toEqual([]);
  });

  it("flags standalone tool rows that leak as assistant response text", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "claude-test.jsonl"),
      [
        JSON.stringify({ type: "response", content: "Bash(cd /tmp && git status)" }),
        JSON.stringify({ type: "response", content: "Read 2 files (ctrl+o to expand)" }),
        "",
      ].join("\n"),
    );

    const summary = auditAgentOutputParserCorpus({ historyDirs: [dir] });

    expect(summary.scanned).toBe(2);
    expect(summary.countsByFlag["status-leak-response"]).toBe(2);
    expect(summary.findings).toHaveLength(2);
  });

  it("ignores non-response history records", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "codex-test.jsonl"),
      [
        JSON.stringify({ type: "prompt", content: "› Explain this codebase" }),
        JSON.stringify({ type: "git", content: "} }" }),
        "",
      ].join("\n"),
    );

    const summary = auditAgentOutputParserCorpus({ historyDirs: [dir] });

    expect(summary.scanned).toBe(0);
    expect(summary.findings).toEqual([]);
  });

  it("keeps aggregate counts when finding samples are truncated", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "claude-test.jsonl"),
      [
        JSON.stringify({ type: "response", content: "Bash(terminal-notifier -title ClaudeCode) leak one" }),
        JSON.stringify({ type: "response", content: "Bash(terminal-notifier -title ClaudeCode) leak two" }),
        "",
      ].join("\n"),
    );

    const summary = auditAgentOutputParserCorpus({ historyDirs: [dir], maxFindings: 1 });

    expect(summary.countsByFlag["status-leak-response"]).toBe(2);
    expect(summary.findings).toHaveLength(1);
  });

  it("filters findings and counts to requested flags", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "codex-test.jsonl"),
      [
        JSON.stringify({
          type: "response",
          content: "› Explain this codebase\n\n  gpt-5.5 medium · ~/workspace/project",
        }),
        JSON.stringify({
          type: "response",
          content: "Bash(terminal-notifier -title ClaudeCode) appeared as visible assistant prose",
        }),
        "",
      ].join("\n"),
    );

    const summary = auditAgentOutputParserCorpus({
      historyDirs: [dir],
      flags: ["status-leak-response"],
    });

    expect(summary.scanned).toBe(2);
    expect(summary.countsByFlag["prompt-from-response-record"]).toBe(0);
    expect(summary.countsByFlag["status-leak-response"]).toBe(1);
    expect(summary.findings).toEqual([
      expect.objectContaining({
        blockType: "response",
        flags: ["status-leak-response"],
      }),
    ]);
  });
});
