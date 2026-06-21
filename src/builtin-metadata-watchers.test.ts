import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initPaths, getPlansDir, getStatusDir, getHistoryDir } from "./paths.js";
import { createBuiltinMetadataWatchers } from "./builtin-metadata-watchers.js";
import { writeTask } from "./tasks.js";
import { appendTurn } from "./context/history.js";

describe("createBuiltinMetadataWatchers", () => {
  let repoRoot = "";
  const statuses: Array<[string, string, string | undefined]> = [];
  const progresses: Array<[string, number, number, string | undefined]> = [];
  const logs: Array<[string, string, string | undefined]> = [];
  const contexts: Array<[string, string | undefined, string | undefined, number | undefined]> = [];
  const events: Array<[string, string, string | undefined]> = [];

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-watchers-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
    statuses.length = 0;
    progresses.length = 0;
    logs.length = 0;
    contexts.length = 0;
    events.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("loads initial status and plan progress", () => {
    mkdirSync(getStatusDir(), { recursive: true });
    mkdirSync(getPlansDir(), { recursive: true });
    writeFileSync(join(getStatusDir(), "s1.md"), "Working through auth\nmore");
    writeFileSync(
      join(getPlansDir(), "s1.md"),
      ["# Plan", "", "- [x] inspect", "- [ ] patch", "- [ ] test"].join("\n"),
    );

    const watchers = createBuiltinMetadataWatchers({
      projectRoot: repoRoot,
      projectId: "proj",
      serverHost: "127.0.0.1",
      serverPort: 43000,
      metadata: {
        setStatus(session, text, tone) {
          statuses.push([session, text, tone]);
        },
        setProgress(session, current, total, label) {
          progresses.push([session, current, total, label]);
        },
        log() {},
        clearLog() {},
        setContext(session, context) {
          contexts.push([session, context.worktreeName, context.branch, context.pr?.number]);
        },
        emitEvent(session, event) {
          events.push([session, event.kind, event.message]);
        },
        markSeen() {},
        setActivity() {},
        setAttention() {},
      },
    });

    for (const watcher of watchers) watcher.start?.();

    expect(statuses).toContainEqual(["s1", "Working through auth", "info"]);
    expect(progresses).toContainEqual(["s1", 1, 3, "plan"]);
    expect(events).toContainEqual(["s1", "status", "Working through auth"]);
  });

  it("primes initial task and history metadata without replaying logs or events", async () => {
    mkdirSync(getHistoryDir(), { recursive: true });
    await writeTask({
      id: "t1",
      status: "assigned",
      assignedBy: "leader",
      assignedTo: "s1",
      description: "Ship auth",
      prompt: "do it",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    writeFileSync(
      join(getHistoryDir(), "s1.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), type: "prompt", content: "Explain auth flow" }) + "\n",
    );

    const watchers = createBuiltinMetadataWatchers({
      projectRoot: repoRoot,
      projectId: "proj",
      serverHost: "127.0.0.1",
      serverPort: 43000,
      metadata: {
        setStatus() {},
        setProgress() {},
        log(session, message, opts) {
          logs.push([session, message, opts?.source]);
        },
        clearLog() {},
        setContext(session, context) {
          contexts.push([session, context.worktreeName, context.branch, context.pr?.number]);
        },
        emitEvent(session, event) {
          events.push([session, event.kind, event.message]);
        },
        markSeen() {},
        setActivity() {},
        setAttention() {},
      },
    });

    for (const watcher of watchers) watcher.start?.();

    expect(logs).toEqual([]);
    expect(events).not.toContainEqual(["s1", "task_assigned", "Task: Ship auth"]);
    expect(events).not.toContainEqual(["s1", "prompt", "Explain auth flow"]);
  });

  it("logs and emits new task and history updates after startup priming", async () => {
    vi.useFakeTimers();
    mkdirSync(getHistoryDir(), { recursive: true });
    writeFileSync(
      join(getHistoryDir(), "s1.jsonl"),
      JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", type: "prompt", content: "Existing prompt" }) + "\n",
    );

    const watchers = createBuiltinMetadataWatchers({
      projectRoot: repoRoot,
      projectId: "proj",
      serverHost: "127.0.0.1",
      serverPort: 43000,
      metadata: {
        setStatus() {},
        setProgress() {},
        log(session, message, opts) {
          logs.push([session, message, opts?.source]);
        },
        clearLog() {},
        setContext(session, context) {
          contexts.push([session, context.worktreeName, context.branch, context.pr?.number]);
        },
        emitEvent(session, event) {
          events.push([session, event.kind, event.message]);
        },
        markSeen() {},
        setActivity() {},
        setAttention() {},
      },
    });

    for (const watcher of watchers) watcher.start?.();
    expect(logs).toEqual([]);
    expect(events).toEqual([]);

    await writeTask({
      id: "t2",
      status: "done",
      assignedBy: "leader",
      assignedTo: "s2",
      description: "Finish repair",
      prompt: "do it",
      result: "done",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    appendTurn("s1", {
      ts: "2026-01-01T00:00:01.000Z",
      type: "response",
      content: "Repair finished",
    });

    await vi.advanceTimersByTimeAsync(2_100);
    await vi.advanceTimersByTimeAsync(100);
    for (const watcher of watchers) await watcher.stop?.();

    expect(logs).toContainEqual(["s2", "Done: Finish repair", "tasks"]);
    expect(events).toContainEqual(["s2", "task_done", "Done: Finish repair"]);
    expect(logs).toContainEqual(["s1", "Response: Repair finished", "history"]);
    expect(events).toContainEqual(["s1", "response", "Repair finished"]);
  });

  it("does not emit task notifications for tasks that already exist on startup", async () => {
    await writeTask({
      id: "t1",
      status: "done",
      assignedBy: "leader",
      assignedTo: "s1",
      description: "Review of bybit-open-trigger",
      prompt: "review it",
      result: "done",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const watchers = createBuiltinMetadataWatchers({
      projectRoot: repoRoot,
      projectId: "proj",
      serverHost: "127.0.0.1",
      serverPort: 43000,
      metadata: {
        setStatus() {},
        setProgress() {},
        log(session, message, opts) {
          logs.push([session, message, opts?.source]);
        },
        clearLog() {},
        setContext() {},
        emitEvent(session, event) {
          events.push([session, event.kind, event.message]);
        },
        markSeen() {},
        setActivity() {},
        setAttention() {},
      },
    });

    for (const watcher of watchers) watcher.start?.();

    expect(logs).not.toContainEqual(["s1", "Done: Review of bybit-open-trigger", "tasks"]);
    expect(events).not.toContainEqual(["s1", "task_done", "Done: Review of bybit-open-trigger"]);
  });
});
