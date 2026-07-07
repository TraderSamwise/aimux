import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  discoverBackendSessionId,
  discoverClaudeBackendSessionId,
  discoverCodexBackendSessionId,
} from "./backend-session-discovery.js";

const UUID_A = "0710a963-a473-430f-9f9a-e27dd4546328";
const UUID_B = "11111111-2222-3333-4444-555555555555";

describe("discoverClaudeBackendSessionId", () => {
  let projectsDir: string;
  const cwd = "/Users/x/cs/proj/.aimux/worktrees/chat-sync";
  const encoded = "-Users-x-cs-proj--aimux-worktrees-chat-sync";

  beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), "aimux-claude-projects-"));
  });
  afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
  });

  function writeTranscript(name: string, mtimeSec: number): void {
    const dir = join(projectsDir, encoded);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, "{}\n");
    utimesSync(path, mtimeSec, mtimeSec);
  }

  it("returns the single transcript's uuid for the worktree", () => {
    writeTranscript(`${UUID_A}.jsonl`, 1000);
    expect(discoverClaudeBackendSessionId(cwd, projectsDir)).toBe(UUID_A);
  });

  it("refuses (returns null) when several transcripts make the match ambiguous", () => {
    writeTranscript(`${UUID_A}.jsonl`, 1000);
    writeTranscript(`${UUID_B}.jsonl`, 2000);
    expect(discoverClaudeBackendSessionId(cwd, projectsDir)).toBeNull();
  });

  it("ignores non-uuid and non-jsonl files", () => {
    writeTranscript("not-a-uuid.jsonl", 5000);
    writeTranscript(`${UUID_A}.txt`, 6000);
    writeTranscript(`${UUID_A}.jsonl`, 1000);
    expect(discoverClaudeBackendSessionId(cwd, projectsDir)).toBe(UUID_A);
  });

  it("returns null when the worktree directory is absent", () => {
    expect(discoverClaudeBackendSessionId("/Users/x/other", projectsDir)).toBeNull();
  });

  it("dispatcher requires a cwd and returns null for unknown tools", () => {
    writeTranscript(`${UUID_A}.jsonl`, 1000);
    expect(discoverBackendSessionId("claude", undefined)).toBeNull();
    expect(discoverBackendSessionId("unknown", cwd)).toBeNull();
  });
});

describe("discoverCodexBackendSessionId", () => {
  let codexHome: string;
  let sessionsDir: string;
  let prevCodexHome: string | undefined;
  const cwd = "/Users/x/cs/proj/.aimux/worktrees/chat-sync";

  beforeEach(() => {
    prevCodexHome = process.env.CODEX_HOME;
    codexHome = mkdtempSync(join(tmpdir(), "aimux-codex-home-"));
    process.env.CODEX_HOME = codexHome;
    sessionsDir = join(codexHome, "sessions");
  });
  afterEach(() => {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    rmSync(codexHome, { recursive: true, force: true });
  });

  function writeTranscript(day: string, uuid: string, transcriptCwd: string, mtimeSec?: number): void {
    const dir = join(sessionsDir, "2026", "06", day);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `rollout-2026-06-${day}T00-00-00-${uuid}.jsonl`);
    writeFileSync(path, `${JSON.stringify({ type: "session_meta", payload: { id: uuid, cwd: transcriptCwd } })}\n{}\n`);
    if (mtimeSec !== undefined) utimesSync(path, mtimeSec, mtimeSec);
  }

  it("returns the single transcript id for the cwd", () => {
    writeTranscript("14", UUID_A, cwd);
    expect(discoverCodexBackendSessionId(cwd, sessionsDir)).toBe(UUID_A);
  });

  it("handles large codex session_meta records without reading full transcripts", () => {
    const dir = join(sessionsDir, "2026", "06", "14");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `rollout-2026-06-14T00-00-00-${UUID_A}.jsonl`),
      `${JSON.stringify({
        type: "session_meta",
        payload: { id: UUID_A, cwd, base_instructions: { text: "x".repeat(80 * 1024) } },
      })}\n{"type":"response","payload":{"text":"not read by discovery"}}\n`,
    );

    expect(discoverCodexBackendSessionId(cwd, sessionsDir)).toBe(UUID_A);
  });

  it("refuses when several transcripts make the cwd match ambiguous", () => {
    writeTranscript("14", UUID_A, cwd);
    writeTranscript("15", UUID_B, cwd);
    expect(discoverCodexBackendSessionId(cwd, sessionsDir)).toBeNull();
  });

  it("can ignore old transcripts when launch-time discovery has a lower bound", () => {
    writeTranscript("14", UUID_A, cwd, 1000);
    writeTranscript("15", UUID_B, cwd, 2000);
    expect(discoverCodexBackendSessionId(cwd, sessionsDir, { sinceMs: 1500_000 })).toBe(UUID_B);
  });

  it("ignores transcripts for other cwd values", () => {
    writeTranscript("14", UUID_A, "/Users/x/other");
    expect(discoverCodexBackendSessionId(cwd, sessionsDir)).toBeNull();
  });

  it("dispatcher handles codex when the cwd has one transcript", () => {
    writeTranscript("14", UUID_A, cwd);
    expect(discoverBackendSessionId("codex", cwd)).toBe(UUID_A);
  });
});
