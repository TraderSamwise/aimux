import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initPaths } from "../paths.js";
import {
  recordTopologyBackendSessionId,
  resolveAgentIdentity,
  resolveBackendSessionId,
} from "./backend-session-ids.js";
import { listTopologySessionStates, upsertTopologySession } from "./topology-sessions.js";

describe("recordTopologyBackendSessionId", () => {
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-backend-session-ids-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("strictly records a backend id into an existing topology row", () => {
    upsertTopologySession(
      {
        id: "claude-1",
        tool: "claude",
        toolConfigKey: "claude",
        command: "claude",
        args: [],
        lifecycle: "offline",
        worktreePath: repoRoot,
      },
      "offline",
      { projectRoot: repoRoot },
    );

    expect(
      recordTopologyBackendSessionId({
        projectRoot: repoRoot,
        sessionId: "claude-1",
        backendSessionId: "backend-1",
      }),
    ).toEqual({ sessionId: "claude-1", backendSessionId: "backend-1" });

    expect(listTopologySessionStates().find((session) => session.id === "claude-1")?.backendSessionId).toBe(
      "backend-1",
    );
  });

  it("preserves live tmux binding metadata while latching the backend id", () => {
    upsertTopologySession(
      {
        id: "claude-live",
        tool: "claude",
        toolConfigKey: "claude",
        command: "claude",
        args: [],
        lifecycle: "live",
        worktreePath: repoRoot,
        tmuxTarget: {
          sessionName: "aimux-test",
          windowId: "@1",
          windowIndex: 1,
          windowName: "claude",
        },
      },
      "running",
      { projectRoot: repoRoot },
    );

    recordTopologyBackendSessionId({
      projectRoot: repoRoot,
      sessionId: "claude-live",
      backendSessionId: "backend-live",
    });

    const live = listTopologySessionStates().find((session) => session.id === "claude-live");
    expect(live).toMatchObject({
      status: "running",
      backendSessionId: "backend-live",
      tmuxTarget: {
        sessionName: "aimux-test",
        windowId: "@1",
        windowIndex: 1,
        windowName: "claude",
      },
    });
  });

  it("refuses missing rows and conflicting backend ids", () => {
    expect(() =>
      recordTopologyBackendSessionId({ projectRoot: repoRoot, sessionId: "missing", backendSessionId: "backend-1" }),
    ).toThrow('Agent "missing" is not managed in runtime topology');

    upsertTopologySession(
      {
        id: "claude-1",
        tool: "claude",
        toolConfigKey: "claude",
        command: "claude",
        args: [],
        lifecycle: "offline",
        backendSessionId: "backend-original",
      },
      "offline",
      { projectRoot: repoRoot },
    );

    expect(() =>
      recordTopologyBackendSessionId({
        projectRoot: repoRoot,
        sessionId: "claude-1",
        backendSessionId: "backend-new",
      }),
    ).toThrow('Agent "claude-1" already has backend session "backend-original"');
  });
});

describe("resolveBackendSessionId", () => {
  let repoRoot = "";
  let codexHome = "";
  let claudeHome = "";
  let prevCodexHome: string | undefined;
  let prevClaudeDir: string | undefined;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-resolve-backend-id-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
    // Sandboxed, or the fallback walks the developer's own ~/.codex sessions and
    // the refusal cases pass only because none of them names this temp dir.
    codexHome = mkdtempSync(join(tmpdir(), "aimux-resolve-codex-home-"));
    prevCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    claudeHome = mkdtempSync(join(tmpdir(), "aimux-resolve-claude-home-"));
    prevClaudeDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
  });

  afterEach(() => {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevClaudeDir;
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(claudeHome, { recursive: true, force: true });
  });

  const seed = (id: string, tool: string, worktreePath?: string) =>
    upsertTopologySession(
      {
        id,
        tool,
        toolConfigKey: tool,
        command: tool,
        args: [],
        lifecycle: "live",
        ...(worktreePath ? { worktreePath } : {}),
      },
      "running",
      { projectRoot: repoRoot },
    );

  const writeCodexRollout = (id: string, cwd: string) => {
    const dir = join(codexHome, "sessions", "2026", "08", "08");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `rollout-2026-08-08T00-00-00-${id}.jsonl`),
      `${JSON.stringify({
        timestamp: "2026-08-08T00:00:00.000Z",
        type: "session_meta",
        payload: { id, cwd, originator: "codex-tui" },
      })}\n`,
    );
  };

  it("hands back the id the tool recorded at launch", () => {
    seed("claude-1", "claude", repoRoot);
    recordTopologyBackendSessionId({
      projectRoot: repoRoot,
      sessionId: "claude-1",
      backendSessionId: "0f0e2b1a-1111-2222-3333-444455556666",
    });

    expect(resolveBackendSessionId({ projectRoot: repoRoot, sessionId: "claude-1" })).toEqual({
      ok: true,
      backendSessionId: "0f0e2b1a-1111-2222-3333-444455556666",
      source: "topology",
    });
  });

  it("resolves full identity for graveyarded agents", () => {
    upsertTopologySession(
      {
        id: "claude-gone",
        tool: "claude",
        toolConfigKey: "claude",
        command: "claude",
        args: [],
        lifecycle: "graveyard",
        backendSessionId: "0f0e2b1a-1111-2222-3333-444455556666",
        worktreePath: repoRoot,
      },
      "graveyard",
      { projectRoot: repoRoot },
    );

    expect(resolveAgentIdentity({ projectRoot: repoRoot, sessionId: "claude-gone" })).toEqual({
      ok: true,
      sessionId: "claude-gone",
      backendSessionId: "0f0e2b1a-1111-2222-3333-444455556666",
      source: "topology",
      tool: "claude",
      toolConfigKey: "claude",
      command: "claude",
      status: "graveyard",
      worktreePath: repoRoot,
    });
  });

  /**
   * An agent in the main checkout carries no worktreePath. Searching that
   * directly finds nothing, so the repo root has to stand in for it.
   */
  it("recovers an older agent's id from disk, main checkout included", () => {
    seed("codex-main", "codex");
    writeCodexRollout("019fd6cb-68fc-7cd3-a3bf-7137b47ea6af", repoRoot);

    expect(resolveBackendSessionId({ projectRoot: repoRoot, sessionId: "codex-main" })).toEqual({
      ok: true,
      backendSessionId: "019fd6cb-68fc-7cd3-a3bf-7137b47ea6af",
      source: "discovered",
    });
  });

  /**
   * Both tools record an id at launch now, so a row without one is an agent
   * from before that. Refusing is the point: forking the wrong conversation is
   * worse than declining to fork.
   */
  it("refuses, with a reason, when the store holds nothing for it", () => {
    seed("codex-old", "codex", repoRoot);

    const result = resolveBackendSessionId({ projectRoot: repoRoot, sessionId: "codex-old" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.reason).toContain("codex-old");
    expect(result.reason).toMatch(/no recorded codex session id/);
  });

  /** Two agents in one worktree must not be told apart by guessing. */
  it("refuses rather than pick between two transcripts in one worktree", () => {
    seed("codex-ambiguous", "codex", repoRoot);
    writeCodexRollout("019fd6cb-68fc-7cd3-a3bf-7137b47ea6af", repoRoot);
    writeCodexRollout("019fd6cb-68fc-7cd3-a3bf-7137b47ea6b0", repoRoot);

    expect(resolveBackendSessionId({ projectRoot: repoRoot, sessionId: "codex-ambiguous" }).ok).toBe(false);
  });

  it("refuses for an agent topology does not manage", () => {
    const result = resolveBackendSessionId({ projectRoot: repoRoot, sessionId: "ghost-1" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.reason).toMatch(/not managed in runtime topology/);
  });
});
