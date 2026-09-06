#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/coordination/tasks-threads.json", ROOT);

const tasks = await import(new URL("dist/tasks.js", ROOT));
const threads = await import(new URL("dist/threads.js", ROOT));
const paths = await import(new URL("dist/paths.js", ROOT));
const { createRuntimeExchangeStore } = await import(new URL("dist/runtime-core/exchange-store.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function jsonThreadSummarySnapshot(snapshot) {
  return {
    summaries: snapshot.summaries,
    messagesByThreadId: Object.fromEntries([...snapshot.messagesByThreadId.entries()]),
  };
}

async function withExchange(exchange, fn) {
  const tempRoot = mkdtempSync(join(tmpdir(), "aimux-tasks-threads-contract-"));
  const previousHome = process.env.AIMUX_HOME;
  process.env.AIMUX_HOME = join(tempRoot, ".aimux");
  const repoRoot = join(tempRoot, "repo");
  mkdirSync(join(repoRoot, ".git"), { recursive: true });
  try {
    await paths.initPaths(repoRoot);
    createRuntimeExchangeStore().write(exchange);
    return fn();
  } finally {
    if (previousHome === undefined) {
      delete process.env.AIMUX_HOME;
    } else {
      process.env.AIMUX_HOME = previousHome;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

const cases = [];
function record(name, source, api, input, output) {
  cases.push({
    id: `tasks-threads-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source,
    api,
    input,
    output,
    inputSha256: hash(input),
  });
}

record(
  "normalizes review status aliases",
  "src/tasks.test.ts",
  "normalizeReviewStatus",
  { values: [null, "", "approve", "approved", "pending", "request-changes", "request_changes", "changes requested", "nope"] },
  [null, "", "approve", "approved", "pending", "request-changes", "request_changes", "changes requested", "nope"].map((value) =>
    tasks.normalizeReviewStatus(value),
  ),
);

const taskExchange = {
  version: 1,
  generatedAt: "2026-08-25T00:00:00.000Z",
  threads: [],
  messages: [],
  tasks: [
    {
      id: "task-pending-review",
      type: "review",
      status: "pending",
      assignee: "reviewer",
      assignedBy: "lead",
      description: "Review patch",
      prompt: "review it",
      reviewStatus: "pending",
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:01.000Z",
    },
    {
      id: "task-active",
      status: "assigned",
      assignee: "worker",
      assignedBy: "lead",
      description: "Patch bug",
      prompt: "fix it",
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:02.000Z",
    },
    {
      id: "task-done",
      status: "done",
      assignee: "worker",
      assignedBy: "lead",
      description: "Old task",
      prompt: "done",
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:03.000Z",
    },
  ],
  handoffs: [],
  reviews: [],
  waits: [],
  inbox: [],
  planRefs: [],
  continuityRefs: [],
  attachmentRefs: [],
};

record(
  "projects task snapshots from exchange without mutation",
  "src/tasks.test.ts",
  "taskSnapshotsFromExchange",
  { exchange: taskExchange },
  tasks.taskSnapshotsFromExchange(taskExchange),
);

record(
  "filters pending review tasks for a role",
  "src/tasks.test.ts",
  "listPendingReviews",
  { exchange: taskExchange, role: "reviewer" },
  await withExchange(taskExchange, () => tasks.listPendingReviews("reviewer")),
);

record(
  "filters active role tasks",
  "src/tasks.test.ts",
  "listTasksForRole",
  { exchange: taskExchange, role: "worker" },
  await withExchange(taskExchange, () => tasks.listTasksForRole("worker")),
);

const threadExchange = {
  version: 1,
  generatedAt: "2026-08-25T00:00:00.000Z",
  threads: [
    {
      id: "thread-a",
      title: "Review API shape",
      kind: "conversation",
      status: "open",
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:03.000Z",
      createdBy: "claude-1",
      participants: ["claude-1", "codex-1"],
    },
    {
      id: "thread-b",
      title: "Check failing test",
      kind: "task",
      status: "waiting",
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:05.000Z",
      createdBy: "codex-1",
      participants: ["codex-1", "claude-2"],
      waitingOn: ["claude-2"],
    },
    {
      id: "thread-c",
      title: "Same timestamp",
      kind: "conversation",
      status: "open",
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:05.000Z",
      createdBy: "codex-1",
      participants: ["codex-1"],
    },
  ],
  messages: [
    {
      id: "msg-1",
      threadId: "thread-a",
      ts: "2026-08-25T00:00:01.000Z",
      from: "claude-1",
      kind: "request",
      body: "Take a look",
    },
    {
      id: "msg-2",
      threadId: "thread-a",
      ts: "2026-08-25T00:00:02.000Z",
      from: "codex-1",
      kind: "reply",
      body: "Looking",
    },
    {
      id: "msg-3",
      threadId: "thread-b",
      ts: "2026-08-25T00:00:03.000Z",
      from: "codex-1",
      kind: "request",
      body: "Please fix test",
    },
  ],
  tasks: [],
  handoffs: [],
  reviews: [],
  waits: [],
  inbox: [],
  planRefs: [],
  continuityRefs: [],
  attachmentRefs: [],
};

record(
  "summarizes threads with latest messages and groups",
  "src/threads.test.ts",
  "threadSummarySnapshotFromExchange",
  { exchange: threadExchange, participantId: null, options: {} },
  jsonThreadSummarySnapshot(threads.threadSummarySnapshotFromExchange(threadExchange, undefined, {})),
);

record(
  "filters thread summaries by participant and limit",
  "src/threads.test.ts",
  "threadSummarySnapshotFromExchange",
  { exchange: threadExchange, participantId: "claude-1", options: { limit: 1, includeMessageGroups: false } },
  jsonThreadSummarySnapshot(
    threads.threadSummarySnapshotFromExchange(threadExchange, "claude-1", { limit: 1, includeMessageGroups: false }),
  ),
);

record(
  "bounds message snapshots from exchange",
  "src/threads.test.ts",
  "readMessageSnapshot",
  { exchange: threadExchange, threadId: "thread-a", options: { limit: 1 } },
  await withExchange(threadExchange, () => threads.readMessageSnapshot("thread-a", { limit: 1 })),
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: ["src/tasks.test.ts", "src/threads.test.ts"],
  generatedBy: "scripts/capture-tasks-threads-contract.mjs",
  description:
    "Task compatibility and thread snapshot contracts captured by running TypeScript tasks and threads helpers against runtime-exchange-shaped inputs.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
