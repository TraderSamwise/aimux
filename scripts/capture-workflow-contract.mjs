#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/workflow/entries.json", ROOT);

const paths = await import(new URL("dist/paths.js", ROOT));
const exchangeStore = await import(new URL("dist/runtime-core/exchange-store.js", ROOT));
const { assignTask } = await import(new URL("dist/orchestration-actions.js", ROOT));
const { openTaskThread } = await import(new URL("dist/threads.js", ROOT));
const { writeTask } = await import(new URL("dist/tasks.js", ROOT));
const { addNotification } = await import(new URL("dist/notifications.js", ROOT));
const {
  buildCoordinationThreadEntries,
  buildWorkflowEntries,
  describeWorkflowNextAction,
  filterWorkflowEntries,
} = await import(new URL("dist/workflow.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function dynamicNormalizer() {
  const ids = new Map();
  const idToken = (id) => {
    if (!ids.has(id)) ids.set(id, `<id:${ids.size + 1}>`);
    return ids.get(id);
  };
  const timestampPattern = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\b/g;
  const idPatterns = [/\b(?:task|thread|msg|notif|review|notification)-[a-z0-9][A-Za-z0-9_.:-]*\b/g];
  const normalizeString = (input) => {
    let text = input.replace(timestampPattern, "<ts>");
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
  return { normalize };
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

function normalizeCase(rawInput, rawOutput, label) {
  assertDynamicStructure(rawInput, `${label}:input`);
  assertDynamicStructure(rawOutput, `${label}:output`);
  const normalizer = dynamicNormalizer();
  return {
    input: normalizer.normalize(rawInput),
    output: normalizer.normalize(rawOutput),
  };
}

async function withProject(label, setup) {
  const repoRoot = mkdtempSync(join(tmpdir(), `aimux-workflow-contract-${label}-`));
  try {
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await paths.initPaths(repoRoot);
    await setup();
    return exchangeStore.createRuntimeExchangeStore().read();
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

async function caseFromExchange(name, scenario, source, setup, participant = "reviewer") {
  const rawExchange = await withProject(scenario, setup);
  const rawOutput = {
    workflowEntries: buildWorkflowEntries(participant, { readOnly: true, exchange: rawExchange }),
    coordinationThreadEntries: buildCoordinationThreadEntries(participant, { readOnly: true }),
  };
  rawOutput.filters = {
    all: filterWorkflowEntries(rawOutput.workflowEntries, "all", participant),
    onMe: filterWorkflowEntries(rawOutput.workflowEntries, "on_me", participant),
    blocked: filterWorkflowEntries(rawOutput.workflowEntries, "blocked", participant),
    families: filterWorkflowEntries(rawOutput.workflowEntries, "families", participant),
  };
  rawOutput.nextActions = rawOutput.workflowEntries.map((entry) => ({
    threadId: entry.thread.id,
    taskId: entry.task?.id,
    action: describeWorkflowNextAction(entry, participant),
  }));
  const { input, output } = normalizeCase({ scenario, participant, exchange: rawExchange }, rawOutput, scenario);
  return {
    id: `workflow-${source}-${scenario}`,
    name,
    source: `src/${source}.test.ts`,
    input,
    output,
    inputSha256: hash(input),
  };
}

const cases = [];

cases.push(
  await caseFromExchange(
    "groups related task and review items into the same workflow family",
    "families",
    "workflow",
    async () => {
      const created = await assignTask({
        from: "claude-lead",
        to: "codex-worker",
        description: "Audit the parser failure path",
      });
      const reviewTask = {
        id: "review-parser",
        status: "pending",
        assignedBy: "codex-worker",
        description: "Review: Audit the parser failure path",
        prompt: "Please review the parser fix.",
        createdAt: new Date(Date.now() + 1).toISOString(),
        updatedAt: new Date(Date.now() + 1).toISOString(),
        assignee: "reviewer",
        type: "review",
        reviewStatus: "pending",
        reviewOf: created.task.id,
      };
      openTaskThread(reviewTask.id, {
        title: reviewTask.description,
        createdBy: "codex-worker",
        participants: ["codex-worker", "reviewer"],
        kind: "review",
      });
      await writeTask(reviewTask);
    },
  ),
);

cases.push(
  await caseFromExchange(
    "excludes notification-tagged threads from coordination thread entries",
    "notification-filter",
    "workflow",
    async () => {
      addNotification({
        title: "aimux / beautify-tui",
        body: "Needs input: claude @ beautify-tui - Claude is waiting for your input",
        sessionId: "claude-x",
        kind: "needs_input",
      });
      await assignTask({ from: "claude-lead", to: "codex-worker", description: "Audit the parser failure path" });
    },
    "user",
  ),
);

cases.push(
  await caseFromExchange(
    "filters workflow entries by waiting-on-me, blocked, and families",
    "filters",
    "workflow",
    async () => {
      const created = await assignTask({
        from: "claude-lead",
        to: "reviewer",
        description: "Audit the parser failure path",
      });
      const reviewTask = {
        id: "review-filter",
        status: "blocked",
        assignedBy: "reviewer",
        description: "Review: Audit the parser failure path",
        prompt: "Please review the parser fix.",
        createdAt: new Date(Date.now() + 1).toISOString(),
        updatedAt: new Date(Date.now() + 1).toISOString(),
        assignee: "reviewer",
        type: "review",
        reviewStatus: "pending",
        reviewOf: created.task.id,
        assignedTo: "reviewer",
      };
      openTaskThread(reviewTask.id, {
        title: reviewTask.description,
        createdBy: "reviewer",
        participants: ["reviewer", "claude-lead"],
        kind: "review",
      });
      await writeTask(reviewTask);
    },
  ),
);

cases.push(
  await caseFromExchange(
    "derives next action labels for handoff, review, task, and plain thread states",
    "next-actions",
    "workflow",
    async () => {
      const store = exchangeStore.createRuntimeExchangeStore();
      store.update((exchange) => ({
        ...exchange,
        generatedAt: "2026-01-01T00:00:00.000Z",
        threads: [
          {
            id: "handoff-waiting",
            title: "Take parser follow-up",
            kind: "handoff",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:06.000Z",
            createdBy: "claude-lead",
            participants: ["claude-lead", "reviewer"],
            status: "waiting",
            owner: "claude-lead",
            waitingOn: ["reviewer"],
          },
          {
            id: "review-waiting",
            title: "Review parser",
            kind: "review",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:05.000Z",
            createdBy: "claude-lead",
            participants: ["claude-lead", "reviewer"],
            status: "waiting",
            owner: "claude-lead",
            waitingOn: ["reviewer"],
            taskId: "review-task",
          },
          {
            id: "task-assigned",
            title: "Continue parser",
            kind: "task",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:04.000Z",
            createdBy: "claude-lead",
            participants: ["claude-lead", "codex-worker"],
            status: "open",
            waitingOn: [],
            taskId: "task-assigned",
          },
          {
            id: "thread-blocked",
            title: "Blocked discussion",
            kind: "handoff",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:03.000Z",
            createdBy: "claude-lead",
            participants: ["claude-lead", "codex-worker"],
            status: "blocked",
            waitingOn: [],
          },
        ],
        tasks: [
          {
            id: "review-task",
            status: "pending",
            assignedBy: "claude-lead",
            assignedTo: "reviewer",
            description: "Review parser",
            prompt: "Please review parser.",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            type: "review",
            reviewStatus: "changes_requested",
          },
          {
            id: "task-assigned",
            status: "assigned",
            assignedBy: "claude-lead",
            assignedTo: "codex-worker",
            description: "Continue parser",
            prompt: "Continue parser.",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        messages: [
          {
            id: "msg-waiting",
            threadId: "handoff-waiting",
            ts: "2026-01-01T00:00:06.000Z",
            from: "claude-lead",
            to: ["reviewer"],
            kind: "handoff",
            body: "Take parser follow-up.",
          },
        ],
      }));
    },
  ),
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/workflow.test.ts",
  generatedBy: "scripts/capture-workflow-contract.mjs",
  description:
    "Workflow entry, coordination-thread, filter, family, and next-action contracts captured by running TypeScript workflow helpers over runtime-exchange snapshots.",
  normalization: {
    ids: "Generated and fixture ids are tokenized in first-appearance order where they match dynamic exchange id patterns.",
    timestamps: "ISO timestamps are replaced with <ts> after per-object monotonicity checks.",
  },
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
