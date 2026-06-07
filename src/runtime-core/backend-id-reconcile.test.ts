import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initPaths } from "../paths.js";
import { reconcileOfflineBackendSessionIds } from "./backend-id-reconcile.js";
import { listTopologySessionStates, saveRuntimeTopologySessions } from "./topology-sessions.js";

describe("reconcileOfflineBackendSessionIds", () => {
  let repoRoot = "";
  let claudeHome = "";
  let prevClaudeDir: string | undefined;
  const UUID = "0710a963-a473-430f-9f9a-e27dd4546328";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-reconcile-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
    claudeHome = mkdtempSync(join(tmpdir(), "aimux-claude-home-"));
    prevClaudeDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
  });

  afterEach(() => {
    if (prevClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevClaudeDir;
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(claudeHome, { recursive: true, force: true });
  });

  function seedOfflineClaude(id: string, cwd: string, backendSessionId?: string): void {
    saveRuntimeTopologySessions({
      projectRoot: repoRoot,
      sessions: [
        {
          id,
          tool: "claude",
          toolConfigKey: "claude",
          command: "claude",
          args: [],
          lifecycle: "offline",
          worktreePath: cwd,
          backendSessionId,
        } as any,
      ],
    });
  }

  function writeTranscript(cwd: string, uuid: string): void {
    const dir = join(claudeHome, "projects", cwd.replace(/[/.]/g, "-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${uuid}.jsonl`), "{}\n");
  }

  it("backfills a missing backend id from the on-disk transcript into topology", () => {
    const cwd = join(repoRoot, "wt", "feature");
    seedOfflineClaude("claude-1", cwd);
    writeTranscript(cwd, UUID);

    const result = reconcileOfflineBackendSessionIds(repoRoot);

    expect(result.reconciled).toEqual([{ id: "claude-1", backendSessionId: UUID }]);
    const offline = listTopologySessionStates({ statuses: ["offline"] }).find((s) => s.id === "claude-1");
    expect(offline?.backendSessionId).toBe(UUID);
  });

  it("leaves sessions that already have a backend id untouched", () => {
    const cwd = join(repoRoot, "wt", "feature");
    seedOfflineClaude("claude-1", cwd, "existing-id");
    writeTranscript(cwd, UUID);

    const result = reconcileOfflineBackendSessionIds(repoRoot);

    expect(result.reconciled).toEqual([]);
    const offline = listTopologySessionStates({ statuses: ["offline"] }).find((s) => s.id === "claude-1");
    expect(offline?.backendSessionId).toBe("existing-id");
  });

  it("skips sessions with no discoverable transcript", () => {
    seedOfflineClaude("claude-1", join(repoRoot, "wt", "feature"));

    const result = reconcileOfflineBackendSessionIds(repoRoot);

    expect(result.reconciled).toEqual([]);
  });

  it("refuses to bind when the worktree dir is ambiguous (several transcripts)", () => {
    const cwd = join(repoRoot, "wt", "shared");
    seedOfflineClaude("claude-1", cwd);
    writeTranscript(cwd, UUID);
    writeTranscript(cwd, "99999999-8888-7777-6666-555555555555");

    const result = reconcileOfflineBackendSessionIds(repoRoot);

    expect(result.reconciled).toEqual([]);
    const offline = listTopologySessionStates({ statuses: ["offline"] }).find((s) => s.id === "claude-1");
    expect(offline?.backendSessionId).toBeUndefined();
  });

  it("is idempotent: a second run reconciles nothing", () => {
    const cwd = join(repoRoot, "wt", "feature");
    seedOfflineClaude("claude-1", cwd);
    writeTranscript(cwd, UUID);

    expect(reconcileOfflineBackendSessionIds(repoRoot).reconciled).toHaveLength(1);
    expect(reconcileOfflineBackendSessionIds(repoRoot).reconciled).toEqual([]);
    const offline = listTopologySessionStates({ statuses: ["offline"] }).find((s) => s.id === "claude-1");
    expect(offline?.backendSessionId).toBe(UUID);
  });
});
