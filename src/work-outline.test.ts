import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProjectStateDirFor, initPaths } from "./paths.js";
import {
  getWorkOutlineEntry,
  listWorkOutlineEntries,
  readWorkOutlineState,
  updateWorkOutlineEntry,
  WORK_OUTLINE_MAX_ENTRIES,
  WORK_OUTLINE_MAX_SESSION_IDS,
  WORK_OUTLINE_SESSION_ID_MAX_CHARS,
  WORK_OUTLINE_SUMMARY_MAX_CHARS,
  WORK_OUTLINE_TITLE_MAX_CHARS,
} from "./work-outline.js";

function gitInit(cwd: string): void {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_COMMON_DIR;
  execFileSync("git", ["init"], { cwd, stdio: "ignore", env });
}

describe("work outline store", () => {
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-work-outline-"));
    gitInit(repoRoot);
    await initPaths(repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("upserts by topic and worktree while merging session ids", () => {
    const first = updateWorkOutlineEntry(
      {
        topicKey: "Release Train",
        title: "Release train",
        summary: "Prepare the release.",
        sessionId: "codex-a",
        worktreePath: "/repo/main",
        evidence: { source: "tail", startLine: 5, endLine: 9 },
      },
      { projectRoot: repoRoot, now: "2026-08-30T00:00:00.000Z" },
    );
    const second = updateWorkOutlineEntry(
      {
        topicKey: "release train",
        title: "Release train",
        summary: "Release is ready to cut.",
        sessionIds: ["claude-b", "codex-a"],
        worktreePath: "/repo/main",
      },
      { projectRoot: repoRoot, now: "2026-08-30T00:01:00.000Z" },
    );

    expect(second.entryId).toBe(first.entryId);
    expect(second.sessionIds).toEqual(["claude-b", "codex-a"]);
    expect(second.evidence).toEqual({ source: "tail", startLine: 5, endLine: 9 });
    expect(readWorkOutlineState(repoRoot).entries).toHaveLength(1);
  });

  it("filters by status, session, worktree, and search text", () => {
    const alpha = updateWorkOutlineEntry(
      {
        topicKey: "alpha",
        title: "Alpha cleanup",
        summary: "Remove stale paths.",
        sessionId: "codex-a",
        status: "done",
        worktreePath: "/repo/alpha",
      },
      { projectRoot: repoRoot, now: "2026-08-30T00:00:00.000Z" },
    );
    updateWorkOutlineEntry(
      {
        topicKey: "beta",
        title: "Beta scheduler",
        summary: "Scan changed agents.",
        sessionId: "claude-b",
        status: "active",
        worktreePath: "/repo/beta",
      },
      { projectRoot: repoRoot, now: "2026-08-30T00:01:00.000Z" },
    );

    expect(listWorkOutlineEntries({ status: "done" }, repoRoot).map((entry) => entry.entryId)).toEqual([alpha.entryId]);
    expect(listWorkOutlineEntries({ sessionId: "codex-a" }, repoRoot).map((entry) => entry.entryId)).toEqual([
      alpha.entryId,
    ]);
    expect(listWorkOutlineEntries({ worktreePath: "/repo/alpha" }, repoRoot).map((entry) => entry.entryId)).toEqual([
      alpha.entryId,
    ]);
    expect(listWorkOutlineEntries({ q: "stale" }, repoRoot).map((entry) => entry.entryId)).toEqual([alpha.entryId]);
  });

  it("bounds stored entries and truncates large text", () => {
    const title = "t".repeat(WORK_OUTLINE_TITLE_MAX_CHARS + 20);
    const summary = "s".repeat(WORK_OUTLINE_SUMMARY_MAX_CHARS + 20);

    for (let index = 0; index < WORK_OUTLINE_MAX_ENTRIES + 5; index += 1) {
      const now = new Date(Date.UTC(2026, 7, 30, 0, 0, index)).toISOString();
      updateWorkOutlineEntry(
        {
          topicKey: `topic-${index}`,
          title,
          summary,
        },
        { projectRoot: repoRoot, now },
      );
    }

    const state = readWorkOutlineState(repoRoot);
    expect(state.entries).toHaveLength(WORK_OUTLINE_MAX_ENTRIES);
    expect(state.entries[0].title).toHaveLength(WORK_OUTLINE_TITLE_MAX_CHARS);
    expect(state.entries[0].title.endsWith("...")).toBe(true);
    expect(state.entries[0].summary).toHaveLength(WORK_OUTLINE_SUMMARY_MAX_CHARS);
    expect(getWorkOutlineEntry("outline-missing", repoRoot)).toBeUndefined();
  });

  it("bounds and truncates session ids on new and existing entries", () => {
    const longId = `codex-${"x".repeat(WORK_OUTLINE_SESSION_ID_MAX_CHARS + 20)}`;
    const manyIds = Array.from({ length: WORK_OUTLINE_MAX_SESSION_IDS + 20 }, (_, index) => `codex-${index}`);
    const first = updateWorkOutlineEntry(
      {
        topicKey: "session bound",
        title: "Session bound",
        summary: "Keep persisted session id arrays bounded.",
        sessionIds: [longId, ...manyIds],
      },
      { projectRoot: repoRoot, now: "2026-08-30T00:00:00.000Z" },
    );
    const second = updateWorkOutlineEntry(
      {
        topicKey: "session bound",
        title: "Session bound",
        summary: "Keep persisted session id arrays bounded after updates.",
        sessionIds: Array.from({ length: 20 }, (_, index) => `claude-${index}`),
      },
      { projectRoot: repoRoot, now: "2026-08-30T00:01:00.000Z" },
    );

    expect(first.sessionIds).toHaveLength(WORK_OUTLINE_MAX_SESSION_IDS);
    expect(second.sessionIds).toHaveLength(WORK_OUTLINE_MAX_SESSION_IDS);
    expect(second.sessionIds.every((id) => id.length <= WORK_OUTLINE_SESSION_ID_MAX_CHARS)).toBe(true);
    expect(readWorkOutlineState(repoRoot).entries[0]?.sessionIds).toHaveLength(WORK_OUTLINE_MAX_SESSION_IDS);
  });

  it("quarantines corrupt JSON instead of throwing or reparsing forever", () => {
    const path = join(getProjectStateDirFor(repoRoot), "work-outline.json");
    writeFileSync(path, "{not json");

    expect(readWorkOutlineState(repoRoot)).toEqual({ version: 1, entries: [] });
    expect(
      readdirSync(getProjectStateDirFor(repoRoot)).some((file) => file.startsWith("work-outline.json.corrupt-")),
    ).toBe(true);
  });
});
