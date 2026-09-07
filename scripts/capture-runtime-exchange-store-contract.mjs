#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/runtime-exchange/store.json", ROOT);
const storeModule = await import(new URL("dist/runtime-core/exchange-store.js", ROOT));
const retentionModule = await import(new URL("dist/runtime-core/exchange-retention.js", ROOT));
const {
  RuntimeExchangeStore,
  emptyRuntimeExchange,
  inspectRuntimeExchangeStore,
} = storeModule;
const {
  RUNTIME_EXCHANGE_RETENTION,
  compactRuntimeExchange,
  countRuntimeExchangeBytes,
} = retentionModule;

const NOW = "2026-05-25T00:00:00.000Z";
const OLD = "2026-05-01T00:00:00.000Z";
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};
const cases = [];
function record(name, api, input, output) {
  cases.push({
    id: `runtime-exchange-store-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/runtime-core/exchange-store.test.ts",
    api,
    input,
    output,
    inputSha256: hash(input),
  });
}
function withStore(callback) {
  const dir = mkdtempSync(join(tmpdir(), "aimux-runtime-exchange-contract-"));
  try {
    const path = join(dir, "runtime-exchange.yaml");
    return callback(path, new RuntimeExchangeStore(path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function ids(rows) {
  return rows.map((row) => row.id);
}
function thread(id, over = {}) {
  return {
    id,
    title: id,
    kind: "task",
    status: "open",
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: "user",
    participants: ["user", "codex-1"],
    ...over,
  };
}
function message(id, threadId, over = {}) {
  return {
    id,
    threadId,
    ts: NOW,
    from: "user",
    kind: "note",
    body: id,
    ...over,
  };
}
function baseExchange(over = {}) {
  return { ...emptyRuntimeExchange(NOW), ...over };
}
function compactSummary(report) {
  return {
    changed: report.changed,
    threadIds: ids(report.retained.threads),
    messageIds: ids(report.retained.messages),
    taskIds: ids(report.retained.tasks),
    waitIds: ids(report.retained.waits),
    attachmentRefIds: ids(report.retained.attachmentRefs),
    before: report.before,
    after: report.after,
    removed: report.removed,
    bytes: report.bytes,
    retention: report.retention,
  };
}

const fullExchange = baseExchange({
  threads: [
    {
      id: "thread-1",
      title: "Task: wire exchange",
      kind: "task",
      status: "waiting",
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: "user",
      participants: ["user", "codex-1"],
      owner: "codex-1",
      waitingOn: ["codex-1"],
      taskId: "task-1",
      unreadBy: ["codex-1"],
    },
  ],
  messages: [
    {
      id: "msg-1",
      threadId: "thread-1",
      ts: NOW,
      from: "user",
      to: ["codex-1"],
      kind: "request",
      body: "Please wire exchange.",
      taskId: "task-1",
      metadata: { priority: 1, review: false, note: "schema" },
    },
  ],
  tasks: [
    {
      id: "task-1",
      status: "pending",
      assignedBy: "user",
      assignedTo: "codex-1",
      threadId: "thread-1",
      description: "Wire exchange",
      prompt: "Please wire exchange.",
      createdAt: NOW,
      updatedAt: NOW,
      type: "task",
    },
  ],
  handoffs: [
    {
      id: "handoff-1",
      threadId: "thread-1",
      status: "waiting",
      from: "user",
      to: ["codex-1"],
      createdAt: NOW,
      updatedAt: NOW,
    },
  ],
  reviews: [{ id: "review-1", taskId: "task-1", status: "pending", createdAt: NOW, updatedAt: NOW }],
  waits: [
    {
      id: "wait-1",
      status: "waiting",
      subjectKind: "thread",
      subjectId: "thread-1",
      waitingOn: ["codex-1"],
      createdAt: NOW,
      updatedAt: NOW,
    },
  ],
  inbox: [
    {
      id: "inbox-1",
      participantId: "codex-1",
      subjectKind: "thread",
      subjectId: "thread-1",
      state: "waiting",
      urgency: 10,
      updatedAt: NOW,
    },
  ],
  planRefs: [
    {
      id: "plan-1",
      path: "/repo/.aimux/plans/task.md",
      threadId: "thread-1",
      taskId: "task-1",
      title: "Task plan",
      createdAt: NOW,
      updatedAt: NOW,
    },
  ],
  continuityRefs: [
    {
      id: "history-1",
      kind: "history",
      path: "/repo/.aimux/history/codex-1.jsonl",
      threadId: "thread-1",
      createdAt: NOW,
      updatedAt: NOW,
    },
  ],
  attachmentRefs: [
    {
      id: "attachment-1",
      path: "/repo/.aimux/attachments/attachment-1.json",
      contentUrl: "/attachments/attachment-1/content",
      threadId: "thread-1",
      messageId: "msg-1",
      mediaType: "text/plain",
      createdAt: NOW,
      updatedAt: NOW,
    },
  ],
});
record("round-trips the runtime exchange YAML", "writeRead", { exchange: fullExchange }, withStore((_path, store) => {
  store.write(fullExchange);
  return store.read();
}));

record("never lets a caller mutation leak into a later read", "mutationIsolation", { exchange: fullExchange }, withStore((_path, store) => {
  store.write(fullExchange);
  const pristine = structuredClone(store.read());
  const mutated = store.read();
  mutated.threads.push({ ...mutated.threads[0], id: "injected" });
  mutated.threads[0].participants.push("injected");
  mutated.messages[0].metadata.priority = 99;
  mutated.inbox.push({
    id: "injected",
    participantId: "user",
    subjectKind: "thread",
    subjectId: "thread-1",
    state: "unread",
    urgency: 1,
    updatedAt: NOW,
  });
  return { pristine, afterMutationRead: store.read() };
}));

const rewriteExchange = baseExchange({
  threads: [thread("thread-1", { title: "Thread", participants: ["user"] })],
});
record("serves a rewritten file rather than a cached parse", "externalRewrite", { initial: rewriteExchange }, withStore((path, store) => {
  store.write(rewriteExchange);
  const before = store.read().threads[0].title;
  const text = readFileSync(path, "utf-8").replace("title: Thread", "title: Thredz");
  writeFileSync(path, text);
  const after = store.read().threads[0].title;
  rmSync(path, { force: true });
  return { before, after, afterDeleteThreadIds: ids(store.read().threads) };
}));

const compactWriteExchange = baseExchange({
  threads: Array.from({ length: RUNTIME_EXCHANGE_RETENTION.closedWorkflowThreads + 1 }, (_, index) =>
    thread(`thread-${index}`, {
      status: "done",
      updatedAt: `2026-05-25T00:${String(index).padStart(2, "0")}:00.000Z`,
    }),
  ),
});
record("compacts automatically before writing runtime exchange YAML", "writeReadSummary", { exchange: compactWriteExchange }, withStore((_path, store) => {
  store.write(compactWriteExchange);
  return { threadCount: store.read().threads.length };
}));

record("rejects corrupt exchange YAML instead of silently resetting exchange truth", "readCorruptYaml", { yaml: "version: nope\n" }, withStore((path, store) => {
  writeFileSync(path, "version: nope\n");
  try {
    store.read();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) };
  }
}));

record("serializes update with a filesystem lock and releases it after writing", "updateLockRelease", {}, withStore((path, store) => {
  store.update((exchange) => ({
    ...exchange,
    generatedAt: NOW,
    threads: [thread("thread-1", { kind: "conversation", participants: ["user"], createdAt: exchange.generatedAt, updatedAt: exchange.generatedAt })],
  }));
  return { lockExists: existsSync(`${path}.lock`), threadIds: ids(store.read().threads) };
}));

record("recovers a stale update lock owned by a dead process", "deadOwnerLock", { owner: "999999" }, withStore((path, store) => {
  const lockPath = `${path}.lock`;
  mkdirSync(lockPath, { recursive: true });
  writeFileSync(join(lockPath, "owner"), "999999\n");
  store.update((exchange) => ({ ...exchange, generatedAt: NOW }));
  return { lockExists: existsSync(lockPath), version: store.read().version };
}));

record("recovers an aged update lock without an owner file before timing out", "agedOwnerlessLock", { ageMs: 5000 }, withStore((path, store) => {
  const lockPath = `${path}.lock`;
  mkdirSync(lockPath, { recursive: true });
  const staleTime = new Date(Date.now() - 5_000);
  utimesSync(lockPath, staleTime, staleTime);
  store.update((exchange) => ({ ...exchange, generatedAt: NOW }));
  return { lockExists: existsSync(lockPath), version: store.read().version };
}));

const pruningExchange = baseExchange({
  threads: [thread("thread-keep", { title: "Keep", participants: ["user"] })],
  messages: [message("msg-keep", "thread-keep", { body: "keep" }), message("msg-drop", "thread-drop", { body: "drop" })],
  tasks: [
    {
      id: "task-keep",
      status: "pending",
      assignedBy: "user",
      threadId: "thread-keep",
      description: "keep",
      prompt: "keep",
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: "task-drop",
      status: "done",
      assignedBy: "user",
      threadId: "thread-drop",
      description: "drop",
      prompt: "drop",
      createdAt: NOW,
      updatedAt: NOW,
    },
  ],
  handoffs: [{ id: "handoff-drop", threadId: "thread-drop", status: "waiting", from: "user", to: ["codex-1"], createdAt: NOW, updatedAt: NOW }],
  reviews: [
    { id: "review-keep", taskId: "task-keep", status: "pending", createdAt: NOW, updatedAt: NOW },
    { id: "review-drop", taskId: "task-drop", status: "pending", createdAt: NOW, updatedAt: NOW },
  ],
  waits: [
    { id: "wait-keep", status: "waiting", subjectKind: "task", subjectId: "task-keep", waitingOn: ["codex-1"], createdAt: NOW, updatedAt: NOW },
    { id: "wait-drop", status: "waiting", subjectKind: "task", subjectId: "task-drop", waitingOn: ["codex-1"], createdAt: NOW, updatedAt: NOW },
  ],
  inbox: [
    { id: "inbox-keep", participantId: "codex-1", subjectKind: "message", subjectId: "msg-keep", state: "unread", urgency: 1, updatedAt: NOW },
    { id: "inbox-drop", participantId: "codex-1", subjectKind: "message", subjectId: "msg-drop", state: "unread", urgency: 1, updatedAt: NOW },
  ],
  planRefs: [
    { id: "plan-keep", path: "/plan.md", taskId: "task-keep", createdAt: NOW, updatedAt: NOW },
    { id: "plan-drop", path: "/drop.md", taskId: "task-drop", createdAt: NOW, updatedAt: NOW },
  ],
  continuityRefs: [
    { id: "context-keep", kind: "context", path: "/context.md", threadId: "thread-keep", createdAt: NOW, updatedAt: NOW },
    { id: "context-drop", kind: "context", path: "/drop.md", threadId: "thread-drop", createdAt: NOW, updatedAt: NOW },
  ],
  attachmentRefs: [
    { id: "attachment-keep", path: "/a", messageId: "msg-keep", createdAt: NOW, updatedAt: NOW },
    { id: "attachment-drop", path: "/b", messageId: "msg-drop", createdAt: NOW, updatedAt: NOW },
  ],
});
record("prunes records that reference missing exchange subjects", "writeReadIds", { exchange: pruningExchange }, withStore((_path, store) => {
  store.write(pruningExchange);
  const exchange = store.read();
  return {
    messages: ids(exchange.messages),
    tasks: ids(exchange.tasks),
    handoffs: ids(exchange.handoffs),
    reviews: ids(exchange.reviews),
    waits: ids(exchange.waits),
    inbox: ids(exchange.inbox),
    planRefs: ids(exchange.planRefs),
    continuityRefs: ids(exchange.continuityRefs),
    attachmentRefs: ids(exchange.attachmentRefs),
  };
}));

function generatedClosedHistoryExchange(generator) {
  const oldClosedThreads = Array.from({ length: generator.closedThreadCount }, (_, index) =>
    thread(`thread-closed-${index}`, {
      title: `Closed ${index}`,
      status: "done",
      createdAt: OLD,
      updatedAt: `2026-05-01T00:${String(index).padStart(2, "0")}:00.000Z`,
      taskId: `task-closed-${index}`,
    }),
  );
  const activeMessages = Array.from({ length: generator.activeMessageCount }, (_, index) =>
    message(`active-${index}`, "thread-active", {
      ts: `2026-05-25T00:${String(index).padStart(2, "0")}:00.000Z`,
      from: index % 2 === 0 ? "user" : "codex-1",
      kind: "reply",
      body: `active message ${index}`,
    }),
  );
  const latestActiveMessageId = `active-${generator.activeMessageCount - 1}`;
  return baseExchange({
    threads: [
      thread("thread-active", {
        title: "Active",
        status: "waiting",
        createdAt: OLD,
        waitingOn: ["codex-1"],
        unreadBy: ["codex-1"],
        taskId: "task-active",
        lastMessageId: "active-old",
      }),
      ...oldClosedThreads,
    ],
    messages: [
      ...activeMessages,
      ...oldClosedThreads.map((row, index) => message(`closed-message-${index}`, row.id, { ts: row.updatedAt, from: "codex-1", kind: "reply", body: `closed message ${index}` })),
    ],
    tasks: [
      { id: "task-active", status: "in_progress", assignedBy: "user", assignedTo: "codex-1", threadId: "thread-active", description: "Active task", prompt: "Do active task", createdAt: OLD, updatedAt: NOW },
      ...oldClosedThreads.map((row, index) => ({ id: `task-closed-${index}`, status: "done", assignedBy: "user", assignedTo: "codex-1", threadId: row.id, description: `Closed task ${index}`, prompt: `Do closed task ${index}`, createdAt: OLD, updatedAt: row.updatedAt })),
    ],
    waits: [
      { id: "wait-active", status: "waiting", subjectKind: "thread", subjectId: "thread-active", waitingOn: ["codex-1"], createdAt: OLD, updatedAt: NOW },
      { id: "wait-pruned", status: "satisfied", subjectKind: "thread", subjectId: "thread-closed-0", waitingOn: ["codex-1"], createdAt: OLD, updatedAt: OLD },
    ],
    attachmentRefs: [
      { id: "attachment-active", path: "/active", messageId: latestActiveMessageId, createdAt: NOW, updatedAt: NOW },
      { id: "attachment-pruned", path: "/pruned", messageId: "active-0", createdAt: OLD, updatedAt: OLD },
    ],
  });
}
const closedHistoryGenerator = {
  closedThreadCount: RUNTIME_EXCHANGE_RETENTION.closedWorkflowThreads + 5,
  activeMessageCount: RUNTIME_EXCHANGE_RETENTION.activeThreadMessages + 10,
};
const closedHistoryExchange = generatedClosedHistoryExchange(closedHistoryGenerator);
record("compacts closed exchange history while preserving active workflow state", "compactGeneratedClosedHistorySummary", {
  generator: { type: "closed-history", ...closedHistoryGenerator },
}, compactSummary(compactRuntimeExchange(closedHistoryExchange)));

function notificationExchange(generator) {
  const { prefix, tagged, threadCount } = generator;
  const threads = Array.from({ length: threadCount }, (_, index) =>
    thread(`${prefix}-${index}`, {
      title: `Notification ${index}`,
      kind: "conversation",
      createdAt: `2026-05-25T00:${String(index).padStart(2, "0")}:00.000Z`,
      updatedAt: `2026-05-25T00:${String(index).padStart(2, "0")}:00.000Z`,
      createdBy: "aimux",
      participants: ["aimux", "project"],
      tags: tagged ? ["notification"] : undefined,
      lastMessageId: `${prefix}-message-${index}-1`,
    }),
  );
  return baseExchange({
    threads,
    messages: threads.flatMap((row, index) => [
      message(`${prefix}-message-${index}-0`, row.id, { ts: row.createdAt, from: "aimux", body: "older" }),
      message(`${prefix}-message-${index}-1`, row.id, { ts: row.updatedAt, from: "aimux", body: "latest" }),
    ]),
  });
}
for (const [name, prefix, tagged] of [
  ["keeps only bounded latest notification threads and their latest messages", "notification", true],
  ["treats notification thread ids as notification threads even without tags", "notification-untagged", false],
]) {
  const generator = {
    type: "notification-threads",
    prefix,
    tagged,
    threadCount: RUNTIME_EXCHANGE_RETENTION.notificationThreads + 3,
  };
  const exchange = notificationExchange(generator);
  const report = compactRuntimeExchange(exchange);
  record(name, "compactGeneratedNotificationSummary", { generator }, {
    threadCount: report.retained.threads.length,
    messageCount: report.retained.messages.length,
    droppedFirstThread: !report.retained.threads.some((row) => row.id === `${prefix}-0`),
    keptLastThread: report.retained.threads.some((row) => row.id === `${prefix}-502`),
    allLatestMessages: report.retained.messages.every((row) => row.id.endsWith("-1")),
  });
}

const hugeBody = "x".repeat(RUNTIME_EXCHANGE_RETENTION.deliveredMessageBodyBytes + 10_000);
const bodyCompactionExchange = baseExchange({
  threads: [thread("thread-1", { kind: "conversation", title: "Active thread", lastMessageId: "msg-pending" })],
  messages: [
    message("msg-delivered", "thread-1", { to: ["codex-1"], deliveredTo: ["codex-1"], kind: "request", body: hugeBody }),
    message("msg-pending", "thread-1", { ts: "2026-05-25T00:01:00.000Z", to: ["codex-1"], kind: "request", body: hugeBody }),
  ],
});
record("compacts oversized delivered message bodies but preserves pending delivery bodies", "compactBodySummary", { exchange: bodyCompactionExchange }, (() => {
  const report = compactRuntimeExchange(bodyCompactionExchange);
  const delivered = report.retained.messages.find((row) => row.id === "msg-delivered");
  const pending = report.retained.messages.find((row) => row.id === "msg-pending");
  return {
    deliveredBodyLength: delivered?.body.length,
    deliveredCompacted: delivered?.metadata?.aimuxBodyCompacted,
    deliveredOriginalBytes: delivered?.metadata?.aimuxBodyOriginalBytes,
    pendingBodyLength: pending?.body.length,
    changed: report.changed,
    removedStoredTextBytesPositive: report.bytes.removed.totalStoredTextBytes > 0,
    compactedMessageBodiesRemoved: report.bytes.removed.compactedMessageBodies,
    idempotentChanged: compactRuntimeExchange(report.retained).changed,
  };
})());

const pendingOldExchange = baseExchange({
  threads: [thread("thread-1", { kind: "conversation", title: "Active thread" })],
  messages: [
    message("msg-pending-old", "thread-1", { to: ["codex-1"], kind: "request", body: "deliver me" }),
    ...Array.from({ length: RUNTIME_EXCHANGE_RETENTION.activeThreadMessages + 5 }, (_, index) =>
      message(`msg-new-${index}`, "thread-1", {
        ts: `2026-05-25T00:${String(index + 1).padStart(2, "0")}:00.000Z`,
        from: "codex-1",
        to: ["user"],
        deliveredTo: ["user"],
        kind: "reply",
        body: `new ${index}`,
      }),
    ),
  ],
});
record("retains pending delivery messages even outside the active thread history window", "compactPendingSummary", { exchange: pendingOldExchange }, (() => {
  const report = compactRuntimeExchange(pendingOldExchange);
  return {
    keptPendingOld: report.retained.messages.some((row) => row.id === "msg-pending-old"),
    newMessageCount: report.retained.messages.filter((row) => row.id.startsWith("msg-new-")).length,
  };
})());

const hugeText = "task text ".repeat(1000);
const taskCompactionExchange = baseExchange({
  tasks: [
    { id: "task-closed", status: "done", assignedBy: "user", assignedTo: "codex-1", description: "Closed task", prompt: hugeText, result: hugeText, createdAt: NOW, updatedAt: NOW },
    { id: "task-active", status: "in_progress", assignedBy: "user", assignedTo: "codex-1", description: "Active task", prompt: hugeText, result: hugeText, createdAt: NOW, updatedAt: NOW },
  ],
});
record("compacts closed task text while preserving active task text", "compactTaskSummary", { exchange: taskCompactionExchange }, (() => {
  const report = compactRuntimeExchange(taskCompactionExchange);
  const closed = report.retained.tasks.find((row) => row.id === "task-closed");
  const active = report.retained.tasks.find((row) => row.id === "task-active");
  return {
    closedPromptLength: closed?.prompt.length,
    closedResultLength: closed?.result.length,
    closedPromptOriginalBytes: closed?.promptOriginalBytes,
    closedResultOriginalBytes: closed?.resultOriginalBytes,
    activePromptLength: active?.prompt.length,
    activeResultLength: active?.result.length,
    compactedTasksRemoved: report.bytes.removed.compactedTasks,
    idempotentChanged: compactRuntimeExchange(report.retained).changed,
  };
})());

const nearThresholdBody = "x".repeat(RUNTIME_EXCHANGE_RETENTION.deliveredMessageBodyBytes + 1);
const nearThresholdExchange = baseExchange({
  threads: [thread("thread-1", { kind: "conversation", title: "Thread", lastMessageId: "msg-1", participants: ["user"] })],
  messages: [message("msg-1", "thread-1", { kind: "request", body: nearThresholdBody })],
});
record("does not compact near-threshold text when metadata overhead would erase the savings", "compactNearThresholdSummary", { exchange: nearThresholdExchange }, (() => {
  const report = compactRuntimeExchange(nearThresholdExchange);
  return {
    changed: report.changed,
    bodyLength: report.retained.messages[0]?.body.length,
    compacted: report.retained.messages[0]?.metadata?.aimuxBodyCompacted ?? null,
  };
})());

const byteCountExchange = baseExchange({
  threads: [thread("thread-1", { kind: "conversation", title: "Thread", lastMessageId: "msg-1", participants: ["user"] })],
  messages: [message("msg-1", "thread-1", { kind: "request", body: "message ".repeat(3000) })],
});
record("reports stored and original text bytes after compaction", "countBytesAfterCompaction", { exchange: byteCountExchange }, countRuntimeExchangeBytes(compactRuntimeExchange(byteCountExchange).retained));

const diagnosticsExchange = baseExchange({
  threads: [
    thread("thread-large", { title: "Large thread", kind: "conversation" }),
    thread("thread-small", { title: "Small thread", kind: "conversation" }),
  ],
  messages: [
    message("msg-pending", "thread-large", { to: ["codex-1"], kind: "request", body: "p".repeat(32) }),
    message("msg-delivered", "thread-large", { from: "codex-1", to: ["user"], deliveredTo: ["user"], kind: "reply", body: "d".repeat(24) }),
    ...Array.from({ length: RUNTIME_EXCHANGE_RETENTION.activeThreadMessages + 5 }, (_, index) =>
      message(`msg-note-large-${index}`, "thread-large", {
        ts: `2026-05-25T00:${String(index + 1).padStart(2, "0")}:00.000Z`,
        from: "codex-1",
        body: "x",
      }),
    ),
    message("msg-note", "thread-small", { from: "codex-1", body: "n".repeat(8) }),
  ],
});
record("reports message delivery bytes and largest retained threads in diagnostics", "inspectSummary", { exchange: diagnosticsExchange }, withStore((path, store) => {
  store.write(diagnosticsExchange);
  const diagnostics = inspectRuntimeExchangeStore(path);
  return {
    messageDelivery: diagnostics.messageDelivery,
    retainedMessageDelivery: diagnostics.retainedMessageDelivery,
    largestRetainedThread: diagnostics.largestRetainedThreads[0],
  };
}));

const danglingTaskExchange = baseExchange({
  tasks: [
    { id: "task-active", status: "in_progress", assignedBy: "user", assignedTo: "codex-1", threadId: "thread-missing", description: "keep active", prompt: "keep active", createdAt: NOW, updatedAt: NOW },
    { id: "task-done", status: "done", assignedBy: "user", assignedTo: "codex-1", threadId: "thread-missing", description: "drop done", prompt: "drop done", createdAt: NOW, updatedAt: NOW },
  ],
});
record("preserves active tasks that reference a missing thread by clearing the dangling thread id", "writeReadTasks", { exchange: danglingTaskExchange }, withStore((_path, store) => {
  store.write(danglingTaskExchange);
  return store.read().tasks;
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/runtime-core/exchange-store.test.ts",
  generatedBy: "scripts/capture-runtime-exchange-store-contract.mjs",
  description: "Runtime exchange persistence, pruning, locking, compaction, and diagnostics contracts captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
