import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendTurn, readHistory } from "./history.js";
import { algorithmicCompact } from "./compactor.js";
import { getContextDir, getProjectStateDir, initPaths } from "../paths.js";

describe("compactor provenance", () => {
  let repoRoot = "";
  let projectStateDir = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-compactor-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
    projectStateDir = getProjectStateDir();
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(projectStateDir, { recursive: true, force: true });
  });

  it("writes summary provenance and append-only checkpoints", () => {
    appendTurn("claude-test", {
      ts: "2026-03-31T00:00:00.000Z",
      type: "prompt",
      content: "write a poem",
    });
    appendTurn("claude-test", {
      ts: "2026-03-31T00:00:05.000Z",
      type: "response",
      content: "here is a poem",
    });

    algorithmicCompact(["claude-test"]);

    const sessionDir = join(getContextDir(), "claude-test");
    const summary = readFileSync(join(sessionDir, "summary.md"), "utf-8");
    const meta = JSON.parse(readFileSync(join(sessionDir, "summary.meta.json"), "utf-8")) as {
      sessionId: string;
      mode: string;
      turns: number;
      firstTurnTs?: string;
      lastTurnTs?: string;
    };
    const checkpoints = readFileSync(join(sessionDir, "summary.checkpoints.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { sessionId: string; mode: string; turns: number });

    expect(summary).toContain("# claude-test — Session Summary");
    expect(summary).toContain("Turns covered: 2");
    expect(summary).toContain("History range: 2026-03-31T00:00:00.000Z -> 2026-03-31T00:00:05.000Z");
    expect(summary).toContain("History digest:");
    expect(meta.sessionId).toBe("claude-test");
    expect(meta.mode).toBe("algorithmic");
    expect(meta.turns).toBe(2);
    expect(meta.firstTurnTs).toBe("2026-03-31T00:00:00.000Z");
    expect(meta.lastTurnTs).toBe("2026-03-31T00:00:05.000Z");
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({ sessionId: "claude-test", mode: "algorithmic", turns: 2 });
  });

  it("does not mutate raw history when compacting repeatedly", () => {
    appendTurn("codex-test", {
      ts: "2026-03-31T00:10:00.000Z",
      type: "prompt",
      content: "investigate login bug",
    });
    appendTurn("codex-test", {
      ts: "2026-03-31T00:10:05.000Z",
      type: "response",
      content: "found the root cause",
    });

    const before = readHistory("codex-test");
    algorithmicCompact(["codex-test"]);
    algorithmicCompact(["codex-test"]);
    const after = readHistory("codex-test");

    const sessionDir = join(getContextDir(), "codex-test");
    const checkpoints = readFileSync(join(sessionDir, "summary.checkpoints.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean);

    expect(after).toEqual(before);
    expect(checkpoints).toHaveLength(2);
  });
});
