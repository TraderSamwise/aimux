#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/orchestration/actions.json", ROOT);

const paths = await import(new URL("dist/paths.js", ROOT));
const exchangeStore = await import(new URL("dist/runtime-core/exchange-store.js", ROOT));
const orchestration = await import(new URL("dist/orchestration.js", ROOT));
const tasks = await import(new URL("dist/tasks.js", ROOT));
const actions = await import(new URL("dist/orchestration-actions.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

function dynamicNormalizer() {
  const ids = new Map();
  const timestamps = new Map();
  const idToken = (id) => {
    if (!ids.has(id)) ids.set(id, `<id:${ids.size + 1}>`);
    return ids.get(id);
  };
  const timestampToken = (_timestamp) => "<ts>";
  const idPatterns = [
    /\b(?:revision|reopen)-[A-Za-z0-9_.:-]+\b/g,
    /\b(?:task|thread|msg)-[a-z0-9]+\b/g,
  ];
  const timestampPattern = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\b/g;
  const normalizeString = (input) => {
    let text = input.replace(timestampPattern, (timestamp) => timestampToken(timestamp));
    for (const pattern of idPatterns) {
      text = text.replace(pattern, (id) => idToken(id));
    }
    return text;
  };
  const normalize = (value) => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, normalize(nested)]));
    }
    return typeof value === "string" ? normalizeString(value) : value;
  };
  return { normalize, ids, timestamps };
}

function assertDynamicStructure(value, label) {
  const failures = [];
  const visit = (node, path = "$") => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!node || typeof node !== "object") return;
    const createdAt = typeof node.createdAt === "string" ? Date.parse(node.createdAt) : undefined;
    const updatedAt = typeof node.updatedAt === "string" ? Date.parse(node.updatedAt) : undefined;
    if (Number.isFinite(createdAt) && Number.isFinite(updatedAt) && createdAt > updatedAt) {
      failures.push(`${path}: createdAt is after updatedAt`);
    }
    const ts = typeof node.ts === "string" ? Date.parse(node.ts) : undefined;
    const deliveredAt = typeof node.deliveredAt === "string" ? Date.parse(node.deliveredAt) : undefined;
    if (Number.isFinite(ts) && Number.isFinite(deliveredAt) && ts > deliveredAt) {
      failures.push(`${path}: ts is after deliveredAt`);
    }
    for (const [key, nested] of Object.entries(node)) {
      if (
        ["id", "taskId", "threadId", "messageId", "lastMessageId", "subjectId", "reviewOf"].includes(key) &&
        typeof nested === "string" &&
        nested.trim() === ""
      ) {
        failures.push(`${path}.${key}: id-like field is empty`);
      }
      visit(nested, `${path}.${key}`);
    }
  };
  visit(value);
  if (failures.length > 0) throw new Error(`${label} dynamic structure failed:\n${failures.join("\n")}`);
}

function normalizeOutput(raw, label) {
  assertDynamicStructure(raw, label);
  const normalizer = dynamicNormalizer();
  const normalized = normalizer.normalize(raw);
  return normalized;
}

function storeSnapshot() {
  return exchangeStore.createRuntimeExchangeStore().read();
}

function stripRouteOnlyFields(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const { ok: _ok, deliveredTo: _deliveredTo, ...rest } = result;
  return rest;
}

async function withProject(label, fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), `aimux-orchestration-actions-contract-${label}-`));
  try {
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await paths.initPaths(repoRoot);
    return normalizeOutput(await fn(repoRoot), label);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

const cases = [];
const add = async (name, scenario, operations, fn) => {
  const input = { scenario, operations };
  cases.push({
    id: `orchestration-actions-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/orchestration-actions.test.ts",
    input,
    output: await withProject(scenario, fn),
    inputSha256: hash(input),
  });
};

await add(
  "creates a targeted task thread and task record",
  "assign-task",
  [
    {
      route: "/tasks/assign",
      body: {
        from: "claude-lead",
        to: "codex-worker",
        description: "Audit the parser failure path",
      },
    },
  ],
  async () => {
    const result = await actions.assignTask({
      from: "claude-lead",
      to: "codex-worker",
      description: "Audit the parser failure path",
    });
    return { result, exchange: storeSnapshot() };
  },
);

await add(
  "creates a handoff thread with a handoff message",
  "send-handoff",
  [
    {
      route: "/handoff",
      body: {
        from: "claude-lead",
        to: ["codex-worker"],
        body: "Take over the UI debug pass from here.",
        title: "UI handoff",
      },
    },
  ],
  () => {
    const result = actions.sendHandoff({
      from: "claude-lead",
      to: ["codex-worker"],
      body: "Take over the UI debug pass from here.",
      title: "UI handoff",
    });
    return { result, exchange: storeSnapshot() };
  },
);

await add(
  "accepts and completes a handoff with matching derived handoff state",
  "handoff-lifecycle",
  [
    {
      route: "/handoff",
      body: {
        from: "claude-lead",
        to: ["codex-worker"],
        body: "Take over the UI debug pass from here.",
      },
      save: "created",
    },
    {
      route: "/handoff/accept",
      body: { threadIdFrom: "created.thread.id", from: "codex-worker" },
    },
    {
      route: "/handoff/complete",
      body: { threadIdFrom: "created.thread.id", from: "codex-worker" },
    },
  ],
  () => {
    const created = actions.sendHandoff({
      from: "claude-lead",
      to: ["codex-worker"],
      body: "Take over the UI debug pass from here.",
    });
    const accepted = actions.acceptHandoff({ threadId: created.thread.id, from: "codex-worker" });
    const completed = actions.completeHandoff({ threadId: created.thread.id, from: "codex-worker" });
    return { result: { created, accepted, completed }, exchange: storeSnapshot() };
  },
);

await add(
  "accepts blocks and completes tasks with matching thread updates",
  "task-lifecycle",
  [
    {
      route: "/tasks/assign",
      body: {
        from: "claude-lead",
        to: "codex-worker",
        description: "Audit the parser failure path",
      },
      save: "created",
    },
    { route: "/tasks/accept", body: { taskIdFrom: "created.task.id", from: "codex-worker" } },
    {
      route: "/tasks/block",
      body: {
        taskIdFrom: "created.task.id",
        from: "codex-worker",
        body: "Need a failing reproduction case.",
      },
    },
    {
      route: "/tasks/complete",
      body: {
        taskIdFrom: "created.task.id",
        from: "codex-worker",
        body: "Found and fixed the parser timeout branch.",
      },
    },
  ],
  async () => {
    const created = await actions.assignTask({
      from: "claude-lead",
      to: "codex-worker",
      description: "Audit the parser failure path",
    });
    const accepted = await actions.acceptTask({ taskId: created.task.id, from: "codex-worker" });
    const blocked = await actions.blockTask({
      taskId: created.task.id,
      from: "codex-worker",
      body: "Need a failing reproduction case.",
    });
    const completed = await actions.completeTask({
      taskId: created.task.id,
      from: "codex-worker",
      body: "Found and fixed the parser timeout branch.",
    });
    return { result: { created, accepted, blocked, completed }, exchange: storeSnapshot() };
  },
);

await add(
  "reactivates a completed task when its thread waits on the assignee again",
  "reactivate-completed-task",
  [
    {
      route: "/tasks/assign",
      body: {
        from: "claude-lead",
        to: "codex-worker",
        description: "Implement the template engine",
      },
      save: "created",
    },
    { route: "/tasks/accept", body: { taskIdFrom: "created.task.id", from: "codex-worker" } },
    {
      route: "/tasks/complete",
      body: { taskIdFrom: "created.task.id", from: "codex-worker", body: "Implementation complete." },
    },
    {
      route: "/threads/send",
      body: {
        threadIdFrom: "created.thread.id",
        from: "claude-lead",
        to: ["codex-worker"],
        kind: "reply",
        body: "Three blockers remain; please fix them before commit.",
      },
    },
  ],
  async () => {
    const created = await actions.assignTask({
      from: "claude-lead",
      to: "codex-worker",
      description: "Implement the template engine",
    });
    const accepted = await actions.acceptTask({ taskId: created.task.id, from: "codex-worker" });
    const completed = await actions.completeTask({
      taskId: created.task.id,
      from: "codex-worker",
      body: "Implementation complete.",
    });
    const blocker = orchestration.sendThreadMessage({
      threadId: created.thread.id,
      from: "claude-lead",
      to: ["codex-worker"],
      kind: "reply",
      body: "Three blockers remain; please fix them before commit.",
    });
    const reconciledTask = tasks.readTask(created.task.id);
    return { result: { created, accepted, completed, blocker, reconciledTask }, exchange: storeSnapshot() };
  },
);

await add(
  "approves reviews, requests changes, and reopens workflow chains",
  "review-workflow",
  [
    {
      route: "/tasks/assign",
      body: {
        from: "claude-lead",
        to: "codex-reviewer",
        description: "Review the parser fix",
        type: "review",
      },
      save: "approvedReview",
    },
    {
      route: "/reviews/approve",
      body: { taskIdFrom: "approvedReview.task.id", from: "codex-reviewer", body: "Looks good." },
    },
    {
      route: "/tasks/assign",
      body: {
        from: "claude-lead",
        to: "codex-reviewer",
        description: "Review follow-up parser fix",
        type: "review",
      },
      save: "changesReview",
    },
    {
      route: "/reviews/request-changes",
      body: {
        taskIdFrom: "changesReview.task.id",
        from: "codex-reviewer",
        body: "Please tighten the timeout assertions.",
      },
    },
    {
      route: "/tasks/reopen",
      body: {
        taskIdFrom: "changesReview.task.id",
        from: "claude-lead",
        body: "Retry the review chain with the latest patch.",
      },
    },
  ],
  async () => {
    const approvedReview = await actions.assignTask({
      from: "claude-lead",
      to: "codex-reviewer",
      description: "Review the parser fix",
      type: "review",
    });
    const approved = await actions.approveReview({
      taskId: approvedReview.task.id,
      from: "codex-reviewer",
      body: "Looks good.",
    });
    const changesReview = await actions.assignTask({
      from: "claude-lead",
      to: "codex-reviewer",
      description: "Review follow-up parser fix",
      type: "review",
    });
    const changes = await actions.requestTaskChanges({
      taskId: changesReview.task.id,
      from: "codex-reviewer",
      body: "Please tighten the timeout assertions.",
    });
    const reopened = await actions.reopenTask({
      taskId: changesReview.task.id,
      from: "claude-lead",
      body: "Retry the review chain with the latest patch.",
    });
    return {
      result: { approvedReview, approved, changesReview, changes, reopened },
      exchange: storeSnapshot(),
    };
  },
);

for (const fixture of cases) {
  fixture.output = JSON.parse(JSON.stringify(fixture.output, (_key, value) => stripRouteOnlyFields(value)));
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/orchestration-actions.test.ts",
  generatedBy: "scripts/capture-orchestration-actions-contract.mjs",
  description:
    "Task, handoff, review, thread-reopen, and runtime-exchange side-effect contracts captured by running TypeScript orchestration action helpers. Generated IDs and timestamps are tokenized in first-appearance order after invariant checks.",
  normalization: {
    ids: "Dynamic task/thread/message/revision/reopen IDs are replaced with <id:n> in first-appearance order.",
    timestamps: "ISO timestamps are replaced with <ts> after per-object monotonicity checks.",
  },
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
