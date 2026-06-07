import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverBackendSessionId, discoverClaudeBackendSessionId } from "./backend-session-discovery.js";

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

  it("dispatcher only handles claude and requires a cwd", () => {
    writeTranscript(`${UUID_A}.jsonl`, 1000);
    expect(discoverBackendSessionId("codex", cwd)).toBeNull();
    expect(discoverBackendSessionId("claude", undefined)).toBeNull();
  });
});
