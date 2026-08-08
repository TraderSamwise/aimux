import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { SessionBootstrapService } from "./session-bootstrap.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  claudeTranscriptPath,
  discoverBackendSessionId,
  discoverClaudeBackendSessionId,
  discoverCodexBackendSessionId,
  relocateClaudeTranscript,
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

describe("discovering a codex id beside a live sibling", () => {
  it("ignores an id another agent already holds", () => {
    // A fork lands in the same worktree as its source, and the source keeps
    // appending to its own transcript — so both fall inside the capture window
    // and the ambiguity check refuses, leaving the fork with no id at all and
    // permanently unresumable. The source's id is already spoken for.
    const home = mkdtempSync(join(tmpdir(), "aimux-codex-sibling-"));
    const cwd = mkdtempSync(join(tmpdir(), "aimux-codex-cwd-"));
    const dir = join(home, "sessions", "2026", "08", "08");
    mkdirSync(dir, { recursive: true });
    const write = (id: string) =>
      writeFileSync(
        join(dir, `rollout-2026-08-08T00-00-00-${id}.jsonl`),
        `${JSON.stringify({ type: "session_meta", payload: { id, cwd } })}\n`,
      );
    const source = "019fd6cb-68fc-7cd3-a3bf-7137b47ea6af";
    const forked = "019fd6cb-68fc-7cd3-a3bf-7137b47ea6b0";
    write(source);
    write(forked);

    const sessionsDir = join(home, "sessions");
    expect(discoverCodexBackendSessionId(cwd, sessionsDir)).toBeNull();
    expect(discoverCodexBackendSessionId(cwd, sessionsDir, { excludeBackendSessionIds: [source] })).toBe(forked);
    // Excluding down to nothing still refuses rather than inventing one.
    expect(
      discoverCodexBackendSessionId(cwd, sessionsDir, {
        excludeBackendSessionIds: [source, forked],
      }),
    ).toBeNull();

    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe("moving a claude conversation between worktrees", () => {
  it("puts the transcript where the target worktree looks for it", () => {
    // Verified against the real CLI: resuming from a foreign directory reports
    // "No conversation found with session ID", and resumes with full history
    // once the transcript is copied across.
    const projects = mkdtempSync(join(tmpdir(), "aimux-claude-projects-"));
    const source = "/Users/someone/cs/proj";
    const target = "/Users/someone/cs/proj/.aimux/worktrees/feature";
    const id = "4849a2ce-ea35-44f3-9206-d8054a5704bc";

    const from = claudeTranscriptPath(source, id, projects);
    mkdirSync(dirname(from), { recursive: true });
    writeFileSync(from, '{"type":"user","message":{"content":"write me a poem"}}\n');

    expect(existsSync(claudeTranscriptPath(target, id, projects))).toBe(false);
    expect(relocateClaudeTranscript(source, target, id, projects)).toBe(true);
    expect(readFileSync(claudeTranscriptPath(target, id, projects), "utf-8")).toContain("write me a poem");
    // Left behind on purpose: the relaunch can fail and this is the only copy.
    expect(existsSync(from)).toBe(true);

    rmSync(projects, { recursive: true, force: true });
  });

  it("reports when there is nothing to move, and no-ops on a same-place move", () => {
    const projects = mkdtempSync(join(tmpdir(), "aimux-claude-projects-empty-"));
    const id = "4849a2ce-ea35-44f3-9206-d8054a5704bc";
    expect(relocateClaudeTranscript("/a", "/b", id, projects)).toBe(false);
    expect(relocateClaudeTranscript("/a", "/a", id, projects)).toBe(true);
    rmSync(projects, { recursive: true, force: true });
  });
});

describe("what a moved session remembers as its args", () => {
  const compose = (base: string[], action: string[], saved: string[]) =>
    SessionBootstrapService.prototype.composeToolArgs.call(null as never, { args: base }, action, saved);

  it("survives being moved twice", () => {
    // Remembering the move's own launch args accumulates a --resume per move:
    // the second move would compose "--resume <new> --resume <old>", and for
    // codex "resume <a> resume <b>" is not even a valid command line.
    const base = ["--dangerously-skip-permissions"];
    const first = "0f0e2b1a-1111-2222-3333-444455556666";

    const firstMove = compose(base, ["--resume", first], base);
    expect(firstMove).toEqual([...base, "--resume", first]);

    const secondMove = compose(base, ["--resume", first], base);
    expect(secondMove).toEqual([...base, "--resume", first]);
    expect(secondMove.filter((arg) => arg === "--resume")).toHaveLength(1);

    const ifWeHadRememberedTheLaunch = compose(base, ["--resume", first], firstMove);
    expect(ifWeHadRememberedTheLaunch.filter((arg) => arg === "--resume")).toHaveLength(2);
  });
});
