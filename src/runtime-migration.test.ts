import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProjectStateDirFor, getRuntimeExchangePath, initPaths } from "./paths.js";
import { buildRuntimeMigrationReport, importRuntimeMigration, rollbackRuntimeMigration } from "./runtime-migration.js";
import { RuntimeExchangeStore, emptyRuntimeExchange } from "./runtime-core/exchange-store.js";

describe("runtime migration tooling", () => {
  const now = "2026-05-26T00:00:00.000Z";
  let repoRoot = "";
  let aimuxHome = "";
  let previousAimuxHome: string | undefined;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-runtime-migration-repo-"));
    aimuxHome = mkdtempSync(join(tmpdir(), "aimux-runtime-migration-home-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    previousAimuxHome = process.env.AIMUX_HOME;
    process.env.AIMUX_HOME = aimuxHome;
  });

  afterEach(() => {
    if (previousAimuxHome === undefined) {
      delete process.env.AIMUX_HOME;
    } else {
      process.env.AIMUX_HOME = previousAimuxHome;
    }
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(aimuxHome, { recursive: true, force: true });
  });

  it("does not copy legacy global agent-facing dirs during path initialization", async () => {
    const projectStateDir = getProjectStateDirFor(repoRoot);
    mkdirSync(join(projectStateDir, "history"), { recursive: true });
    writeFileSync(join(projectStateDir, "history", "codex-1.jsonl"), "{}\n");

    await initPaths(repoRoot);

    expect(existsSync(join(repoRoot, ".aimux", "history", "codex-1.jsonl"))).toBe(false);
    expect(buildRuntimeMigrationReport({ cwd: repoRoot, now }).status).toBe("needs_import");
  });

  it("reports corrupt legacy files and blocks import", async () => {
    await initPaths(repoRoot);
    mkdirSync(join(repoRoot, ".aimux", "threads"), { recursive: true });
    writeFileSync(join(repoRoot, ".aimux", "threads", "thread-1.json"), "{bad");

    const report = buildRuntimeMigrationReport({ cwd: repoRoot, now });

    expect(report.status).toBe("blocked");
    expect(report.diagnostics).toMatchObject([{ severity: "error", kind: "legacy-thread" }]);
    expect(() => importRuntimeMigration({ cwd: repoRoot, now })).toThrow(/blocked/);
  });

  it("imports legacy exchange refs explicitly and writes a rollback manifest", async () => {
    await initPaths(repoRoot);
    const projectStateDir = getProjectStateDirFor(repoRoot);
    const originalExchange = new RuntimeExchangeStore(getRuntimeExchangePath()).write(emptyRuntimeExchange(now));
    mkdirSync(join(repoRoot, ".aimux", "threads"), { recursive: true });
    mkdirSync(join(repoRoot, ".aimux", "tasks"), { recursive: true });
    mkdirSync(join(projectStateDir, "history"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".aimux", "threads", "thread-1.json"),
      JSON.stringify({
        id: "thread-1",
        title: "Task",
        kind: "task",
        status: "waiting",
        createdAt: now,
        updatedAt: now,
        createdBy: "user",
        participants: ["user", "codex-1"],
      }) + "\n",
    );
    writeFileSync(
      join(repoRoot, ".aimux", "tasks", "task-1.json"),
      JSON.stringify({
        id: "task-1",
        status: "pending",
        assignedBy: "user",
        threadId: "thread-1",
        description: "Do task",
        prompt: "Do task",
        createdAt: now,
        updatedAt: now,
      }) + "\n",
    );
    writeFileSync(join(projectStateDir, "history", "codex-1.jsonl"), "{}\n");

    const result = importRuntimeMigration({ cwd: repoRoot, now });
    const manifestPath = join(projectStateDir, "migration-backups", "2026-05-26T00-00-00-000Z", "manifest.json");

    expect(result.exchange.threads.map((thread) => thread.id)).toEqual(["thread-1"]);
    expect(result.exchange.tasks.map((task) => task.id)).toEqual(["task-1"]);
    expect(existsSync(join(repoRoot, ".aimux", "history", "codex-1.jsonl"))).toBe(true);
    expect(existsSync(manifestPath)).toBe(true);
    expect(readFileSync(result.manifest.backups[0]!.backup, "utf8")).toContain(originalExchange.generatedAt);
    writeFileSync(join(repoRoot, ".aimux", "history", "post-import.jsonl"), "{}\n");

    rollbackRuntimeMigration(manifestPath);

    expect(existsSync(join(repoRoot, ".aimux", "history", "codex-1.jsonl"))).toBe(false);
    expect(existsSync(join(repoRoot, ".aimux", "history", "post-import.jsonl"))).toBe(true);
    expect(new RuntimeExchangeStore(getRuntimeExchangePath()).read().generatedAt).toBe(originalExchange.generatedAt);
  });

  it("rollback removes imported runtime exchange when no backup existed", async () => {
    await initPaths(repoRoot);
    mkdirSync(join(repoRoot, ".aimux", "threads"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".aimux", "threads", "thread-1.json"),
      JSON.stringify({
        id: "thread-1",
        title: "Task",
        kind: "task",
        status: "waiting",
        createdAt: now,
        updatedAt: now,
        createdBy: "user",
        participants: ["user", "codex-1"],
      }) + "\n",
    );

    importRuntimeMigration({ cwd: repoRoot, now });
    const manifestPath = join(
      getProjectStateDirFor(repoRoot),
      "migration-backups",
      "2026-05-26T00-00-00-000Z",
      "manifest.json",
    );

    expect(existsSync(getRuntimeExchangePath())).toBe(true);

    rollbackRuntimeMigration(manifestPath);

    expect(existsSync(getRuntimeExchangePath())).toBe(false);
  });

  it("blocks import when authoritative runtime exchange already has records", async () => {
    await initPaths(repoRoot);
    mkdirSync(join(repoRoot, ".aimux", "threads"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".aimux", "threads", "thread-1.json"),
      JSON.stringify({
        id: "thread-1",
        title: "Legacy task",
        kind: "task",
        status: "waiting",
        createdAt: now,
        updatedAt: now,
        createdBy: "user",
        participants: ["user", "codex-1"],
      }) + "\n",
    );
    new RuntimeExchangeStore(getRuntimeExchangePath()).write({
      ...emptyRuntimeExchange(now),
      threads: [
        {
          id: "thread-existing",
          title: "Existing",
          kind: "conversation",
          status: "open",
          createdAt: now,
          updatedAt: now,
          createdBy: "user",
          participants: ["user"],
        },
      ],
    });

    const report = buildRuntimeMigrationReport({ cwd: repoRoot, now });

    expect(report.status).toBe("blocked");
    expect(report.diagnostics).toMatchObject([{ severity: "error", kind: "runtime-exchange" }]);
    expect(() => importRuntimeMigration({ cwd: repoRoot, now })).toThrow(/blocked/);
  });
});
