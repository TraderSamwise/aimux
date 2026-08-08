import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RECORDING_RETENTION_DAYS, planRecordingCleanup, runRecordingCleanup } from "./recording-cleanup.js";

const NOW = Date.UTC(2026, 7, 8);
const DAY = 24 * 60 * 60 * 1000;

describe("recording cleanup", () => {
  let projectsRoot: string;

  const makeRecording = (project: string, name: string, ageDays: number, bytes = 512): string => {
    const dir = join(projectsRoot, project, "recordings");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, "x".repeat(bytes));
    const seconds = (NOW - ageDays * DAY) / 1000;
    utimesSync(path, seconds, seconds);
    return path;
  };

  const plan = (overrides = {}) => planRecordingCleanup({ projectsRoot, now: () => NOW, ...overrides });

  beforeEach(() => {
    projectsRoot = mkdtempSync(join(tmpdir(), "aimux-recordings-"));
  });

  afterEach(() => {
    rmSync(projectsRoot, { recursive: true, force: true });
  });

  it("removes recordings past retention across every project", () => {
    makeRecording("alpha", "claude-a.log", 90);
    makeRecording("beta", "codex-b.log", 45);

    expect(plan().remove.map((entry) => entry.path.split("/").pop())).toEqual(["claude-a.log", "codex-b.log"]);
  });

  it("keeps a recording a live session is still writing", () => {
    // A live session writes continuously, so a recent mtime is the liveness signal.
    makeRecording("alpha", "claude-live.log", 0);

    const result = plan();

    expect(result.remove).toEqual([]);
    expect(result.keptCount).toBe(1);
  });

  it("reaches recordings whose session no longer exists in project state", () => {
    // graveyard-cleanup deletes by session id, so an orphan is unreachable to it.
    makeRecording("alpha", "claude-orphaned.log", 400, 4096);

    expect(plan().remove).toHaveLength(1);
    expect(plan().reclaimableBytes).toBe(4096);
  });

  it("offers the biggest recordings first", () => {
    makeRecording("alpha", "small.log", 90, 100);
    makeRecording("alpha", "huge.log", 90, 9000);
    makeRecording("alpha", "medium.log", 90, 1000);

    expect(plan().remove.map((entry) => entry.path.split("/").pop())).toEqual(["huge.log", "medium.log", "small.log"]);
  });

  it("returns an empty plan when no projects directory exists", () => {
    const result = plan({ projectsRoot: join(projectsRoot, "missing") });

    expect(result.remove).toEqual([]);
    expect(result.reclaimableBytes).toBe(0);
  });

  it("removes nothing unless the caller opts in", async () => {
    makeRecording("alpha", "old.log", 90);
    const removed: string[] = [];

    const result = await runRecordingCleanup(plan(), { removeFile: (path) => removed.push(path) });

    expect(removed).toEqual([]);
    expect(result.dryRun).toBe(true);
  });

  it("removes the planned recordings when asked", async () => {
    makeRecording("alpha", "old.log", 90, 2048);
    const removed: string[] = [];

    const result = await runRecordingCleanup(plan(), { removeFile: (path) => removed.push(path) }, { dryRun: false });

    expect(removed).toHaveLength(1);
    expect(result.removed).toBe(1);
    expect(result.reclaimedBytes).toBe(2048);
  });

  it("counts a failed removal without aborting the sweep", async () => {
    makeRecording("alpha", "bad.log", 90);
    makeRecording("alpha", "good.log", 91);

    const result = await runRecordingCleanup(
      plan(),
      {
        removeFile: (path) => {
          if (path.endsWith("bad.log")) throw new Error("permission denied");
        },
      },
      { dryRun: false },
    );

    expect(result.removed).toBe(1);
    expect(result.failed).toBe(1);
  });

  it("caps how many it removes in one sweep", async () => {
    makeRecording("alpha", "a.log", 90, 300);
    makeRecording("alpha", "b.log", 90, 200);
    makeRecording("alpha", "c.log", 90, 100);
    const removed: string[] = [];

    await runRecordingCleanup(plan(), { removeFile: (path) => removed.push(path) }, { dryRun: false, limit: 2 });

    expect(removed).toHaveLength(2);
  });

  it("keeps a recording whose session the project still knows about", () => {
    // Age cannot distinguish a dead recording from a long-idle live session.
    makeRecording("alpha", "claude-idle.log", 400);
    writeFileSync(join(projectsRoot, "alpha", "state.json"), JSON.stringify({ sessions: [{ id: "claude-idle" }] }));

    const result = plan();

    expect(result.remove).toEqual([]);
    expect(result.keptCount).toBe(1);
  });

  it("still removes a recording whose session is gone from state", () => {
    makeRecording("alpha", "claude-gone.log", 400);
    writeFileSync(join(projectsRoot, "alpha", "state.json"), JSON.stringify({ sessions: [] }));

    expect(plan().remove).toHaveLength(1);
  });

  it("sweeps recordings kept beside a repo, not just the global layout", () => {
    const local = join(projectsRoot, "worktree", ".aimux", "recordings");
    mkdirSync(local, { recursive: true });
    const path = join(local, "codex-local.log");
    writeFileSync(path, "x".repeat(256));
    const seconds = (NOW - 90 * DAY) / 1000;
    utimesSync(path, seconds, seconds);

    expect(plan({ extraDirs: [local] }).remove.map((entry) => entry.path)).toEqual([path]);
  });

  it("defaults to a conservative retention", () => {
    expect(DEFAULT_RECORDING_RETENTION_DAYS).toBe(30);
  });
});
