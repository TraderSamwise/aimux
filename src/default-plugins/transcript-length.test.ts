import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initPaths, getContextDir, getHistoryDir } from "../paths.js";
import { createTranscriptLengthPlugin } from "./transcript-length.js";

describe("createTranscriptLengthPlugin", () => {
  const originalCwd = process.cwd();
  let repoRoot = "";

  beforeEach(async () => {
    vi.useFakeTimers();
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-transcript-plugin-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("resets transcript length after compaction checkpoints", () => {
    const writes: Array<{ session: string; line: "top" | "bottom"; text: string }> = [];
    const plugin = createTranscriptLengthPlugin(
      {
        projectRoot: repoRoot,
        projectId: "test",
        serverHost: "127.0.0.1",
        serverPort: 9999,
        metadata: {
          setStatus: () => {},
          setProgress: () => {},
          log: () => {},
          clearLog: () => {},
          setContext: () => {},
          setStatuslineSegment: (_session, line, segment) => {
            writes.push({ session: _session, line, text: segment.text });
          },
          clearStatuslineSegment: () => {},
          setServices: () => {},
          emitEvent: () => {},
          markSeen: () => {},
          setActivity: () => {},
          setAttention: () => {},
        },
        sessions: {
          list: () => [{ id: "codex-1" }],
        },
      },
      { line: "top" },
    );

    const historyDir = getHistoryDir();
    mkdirSync(historyDir, { recursive: true });
    appendFileSync(
      join(historyDir, "codex-1.jsonl"),
      `${JSON.stringify({ ts: "2026-04-17T00:00:00.000Z", type: "prompt", content: "hello" })}\n`,
    );

    plugin.start?.();
    expect(writes.at(-1)?.text).toMatch(/b|kb|mb/);

    const contextDir = join(getContextDir(), "codex-1");
    mkdirSync(contextDir, { recursive: true });
    writeFileSync(
      join(contextDir, "summary.checkpoints.jsonl"),
      `${JSON.stringify({ lastTurnTs: "2026-04-17T00:00:00.000Z" })}\n`,
    );

    vi.advanceTimersByTime(2_100);
    expect(writes.at(-1)).toEqual({ session: "codex-1", line: "top", text: "0b" });
    plugin.stop?.();
  });

  it("renders 0b when a session has no transcript history", () => {
    const writes: Array<{ session: string; line: "top" | "bottom"; text: string }> = [];
    const plugin = createTranscriptLengthPlugin(
      {
        projectRoot: repoRoot,
        projectId: "test",
        serverHost: "127.0.0.1",
        serverPort: 9999,
        metadata: {
          setStatus: () => {},
          setProgress: () => {},
          log: () => {},
          clearLog: () => {},
          setContext: () => {},
          setStatuslineSegment: (_session, line, segment) => {
            writes.push({ session: _session, line, text: segment.text });
          },
          clearStatuslineSegment: () => {},
          setServices: () => {},
          emitEvent: () => {},
          markSeen: () => {},
          setActivity: () => {},
          setAttention: () => {},
        },
        sessions: {
          list: () => [{ id: "codex-empty" }],
        },
      },
      { line: "top" },
    );

    plugin.start?.();
    expect(writes.at(-1)).toEqual({ session: "codex-empty", line: "top", text: "0b" });
    plugin.stop?.();
  });
});
