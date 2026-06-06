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
        content: "⏺ terminal-notifier appeared as visible assistant prose",
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
        JSON.stringify({ type: "response", content: "⏺ terminal-notifier leak one" }),
        JSON.stringify({ type: "response", content: "⏺ terminal-notifier leak two" }),
        "",
      ].join("\n"),
    );

    const summary = auditAgentOutputParserCorpus({ historyDirs: [dir], maxFindings: 1 });

    expect(summary.countsByFlag["status-leak-response"]).toBe(2);
    expect(summary.findings).toHaveLength(1);
  });
});
