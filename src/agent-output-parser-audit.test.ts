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

  it("does not flag structural raw fragments", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "codex-test.jsonl"),
      `${JSON.stringify({
        type: "response",
        content: "• Ran curl -sS http://127.0.0.1:43190/projects\n\n}\n}",
      })}\n`,
    );

    const summary = auditAgentOutputParserCorpus({
      historyDirs: [dir],
      flags: ["raw-block"],
    });

    expect(summary.scanned).toBe(1);
    expect(summary.countsByFlag["raw-block"]).toBe(0);
    expect(summary.findings).toEqual([]);
  });

  it("does not flag code-close raw fragments", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "codex-test.jsonl"),
      `${JSON.stringify({
        type: "response",
        content: "169 +      },\n    170 +    ],\n    171 +  },\n    172 +];\n• Phase 1 implementation is in.",
      })}\n`,
    );

    const summary = auditAgentOutputParserCorpus({
      historyDirs: [dir],
      flags: ["raw-block"],
    });

    expect(summary.scanned).toBe(1);
    expect(summary.countsByFlag["raw-block"]).toBe(0);
    expect(summary.findings).toEqual([]);
  });

  it("does not flag numbered structural raw snippets", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "codex-test.jsonl"),
      `${JSON.stringify({
        type: "response",
        content: [
          "171 },",
          "⋮ 51 : {",
          '308 + "────────────────────────────────────────────────────────────────────────────────────────────────",',
          "• Verification passed.",
        ].join("\n"),
      })}\n`,
    );

    const summary = auditAgentOutputParserCorpus({
      historyDirs: [dir],
      flags: ["raw-block"],
    });

    expect(summary.scanned).toBe(1);
    expect(summary.countsByFlag["raw-block"]).toBe(0);
    expect(summary.findings).toEqual([]);
  });

  it("does not flag raw file listing rows", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "codex-test.jsonl"),
      `${JSON.stringify({
        type: "response",
        content:
          "• Ran ls -la ~/.aimux/native\n\n" +
          "drwxr-xr-x@ 11 sam staff 352 May 30 12:00 0.1.16-local.fff4f4d",
      })}\n`,
    );

    const summary = auditAgentOutputParserCorpus({
      historyDirs: [dir],
      flags: ["raw-block"],
    });

    expect(summary.scanned).toBe(1);
    expect(summary.countsByFlag["raw-block"]).toBe(0);
    expect(summary.findings).toEqual([]);
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

  it("does not flag embedded historical prompts without footer context", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "codex-test.jsonl"),
      `${JSON.stringify({
        type: "response",
        content: [
          "Earlier transcript:",
          "› Open a PR. run review-coderabbit until green. then merge and cut new branch.",
          "• I opened the PR and checks are running.",
          "  gpt-5.5 high appeared elsewhere in this transcript summary.",
        ].join("\n"),
      })}\n`,
    );

    const summary = auditAgentOutputParserCorpus({
      historyDirs: [dir],
      flags: ["prompt-from-response-record"],
    });

    expect(summary.scanned).toBe(1);
    expect(summary.countsByFlag["prompt-from-response-record"]).toBe(0);
    expect(summary.findings).toEqual([]);
  });

  it("flags response-record prompts that are backed by a footer status row", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "codex-test.jsonl"),
      `${JSON.stringify({
        type: "response",
        content: ["› Explain this codebase", "", "  gpt-5.5 high · ~/workspace/project"].join("\n"),
      })}\n`,
    );

    const summary = auditAgentOutputParserCorpus({
      historyDirs: [dir],
      flags: ["prompt-from-response-record"],
    });

    expect(summary.scanned).toBe(1);
    expect(summary.countsByFlag["prompt-from-response-record"]).toBe(1);
    expect(summary.findings).toEqual([
      expect.objectContaining({
        blockType: "prompt",
        flags: ["prompt-from-response-record"],
      }),
    ]);
  });

  it("does not flag prompts followed by active work status", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "codex-test.jsonl"),
      `${JSON.stringify({
        type: "response",
        content: [
          "› i moved us to a worktree. take a look",
          "",
          "• Working (0s • esc to interrupt)",
          "",
          "› Explain this codebase",
          "",
          "  gpt-5.5 high · ~/workspace/project",
        ].join("\n"),
      })}\n`,
    );

    const summary = auditAgentOutputParserCorpus({
      historyDirs: [dir],
      flags: ["prompt-from-response-record"],
    });

    expect(summary.scanned).toBe(1);
    expect(summary.countsByFlag["prompt-from-response-record"]).toBe(0);
    expect(summary.findings).toEqual([]);
  });

  it("does not flag prompts followed by interruption status", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "codex-test.jsonl"),
      `${JSON.stringify({
        type: "response",
        content: [
          "› Open a PR. run review-coderabbit until green. then merge and cut new branch.",
          "■ Conversation interrupted - tell the model what to do differently.",
          "",
          "› Explain this codebase",
          "",
          "  gpt-5.5 high · ~/workspace/project",
        ].join("\n"),
      })}\n`,
    );

    const summary = auditAgentOutputParserCorpus({
      historyDirs: [dir],
      flags: ["prompt-from-response-record"],
    });

    expect(summary.scanned).toBe(1);
    expect(summary.countsByFlag["prompt-from-response-record"]).toBe(0);
    expect(summary.findings).toEqual([]);
  });

  it("does not flag very short active input text", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "codex-test.jsonl"),
      `${JSON.stringify({
        type: "response",
        content: ["› fa", "", "  gpt-5.5 high · ~/workspace/project"].join("\n"),
      })}\n`,
    );

    const summary = auditAgentOutputParserCorpus({
      historyDirs: [dir],
      flags: ["prompt-from-response-record"],
    });

    expect(summary.scanned).toBe(1);
    expect(summary.countsByFlag["prompt-from-response-record"]).toBe(0);
    expect(summary.findings).toEqual([]);
  });
});
