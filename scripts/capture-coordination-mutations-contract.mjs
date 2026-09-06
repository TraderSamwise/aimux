#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/coordination/mutations.json", ROOT);

const paths = await import(new URL("dist/paths.js", ROOT));
const exchangeStore = await import(new URL("dist/runtime-core/exchange-store.js", ROOT));
const threads = await import(new URL("dist/threads.js", ROOT));
const orchestration = await import(new URL("dist/orchestration.js", ROOT));

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
    input: rawInput,
    output: normalizer.normalize(rawOutput),
  };
}

function storeSnapshot() {
  return exchangeStore.createRuntimeExchangeStore().read();
}

async function withProject(label, fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), `aimux-coordination-mutations-contract-${label}-`));
  try {
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await paths.initPaths(repoRoot);
    return await fn();
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

const cases = [];
async function add(name, source, scenario, operations, fn) {
  const rawInput = { source, scenario, operations };
  const rawOutput = await withProject(scenario, fn);
  const { input, output } = normalizeCase(rawInput, rawOutput, scenario);
  cases.push({
    id: `coordination-mutations-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: `src/${source}.test.ts`,
    input,
    output,
    inputSha256: hash(input),
  });
}

await add(
  "opens conversation threads and records them in the exchange",
  "threads",
  "threads-open",
  [
    {
      route: "/threads/open",
      body: {
        from: "claude-1",
        title: "Review API shape",
        kind: "conversation",
        participants: ["codex-1"],
      },
      save: "opened",
    },
  ],
  () => {
    const thread = threads.createThread({
      title: "Review API shape",
      kind: "conversation",
      createdBy: "claude-1",
      participants: ["claude-1", "codex-1"],
    });
    return { result: { thread }, exchange: storeSnapshot() };
  },
);

await add(
  "appends messages and derives unread inbox state",
  "threads",
  "threads-send",
  [
    {
      route: "/threads/open",
      body: {
        from: "claude-1",
        title: "Ask about parser",
        kind: "conversation",
        participants: ["codex-1"],
      },
      save: "opened",
    },
    {
      route: "/threads/send",
      body: {
        threadIdFrom: "opened.thread.id",
        from: "claude-1",
        to: ["codex-1"],
        kind: "request",
        body: "Why this parser?",
      },
    },
  ],
  () => {
    const thread = threads.createThread({
      title: "Ask about parser",
      kind: "conversation",
      createdBy: "claude-1",
      participants: ["claude-1", "codex-1"],
    });
    const message = threads.appendMessage(thread.id, {
      from: "claude-1",
      to: ["codex-1"],
      kind: "request",
      body: "Why this parser?",
    });
    return {
      result: { thread: threads.readThread(thread.id), message, messages: threads.readMessages(thread.id) },
      exchange: storeSnapshot(),
    };
  },
);

await add(
  "marks a thread seen for one participant",
  "threads",
  "threads-mark-seen",
  [
    {
      route: "/threads/open",
      body: {
        from: "claude-1",
        title: "Ask about parser",
        kind: "conversation",
        participants: ["codex-1"],
      },
      save: "opened",
    },
    {
      route: "/threads/send",
      body: {
        threadIdFrom: "opened.thread.id",
        from: "claude-1",
        to: ["codex-1"],
        kind: "request",
        body: "Why this parser?",
      },
    },
    { route: "/threads/mark-seen", body: { threadIdFrom: "opened.thread.id", session: "codex-1" } },
  ],
  () => {
    const thread = threads.createThread({
      title: "Ask about parser",
      kind: "conversation",
      createdBy: "claude-1",
      participants: ["claude-1", "codex-1"],
    });
    threads.appendMessage(thread.id, {
      from: "claude-1",
      to: ["codex-1"],
      kind: "request",
      body: "Why this parser?",
    });
    const seen = threads.markThreadSeen(thread.id, "codex-1");
    return { result: { thread: seen }, exchange: storeSnapshot() };
  },
);

await add(
  "updates thread status and clears waits when done",
  "threads",
  "threads-status",
  [
    {
      route: "/threads/open",
      body: {
        from: "claude-1",
        title: "Ask about parser",
        kind: "conversation",
        participants: ["codex-1"],
      },
      save: "opened",
    },
    {
      route: "/threads/status",
      body: { threadIdFrom: "opened.thread.id", status: "done", owner: "claude-1" },
    },
  ],
  () => {
    const thread = threads.createThread({
      title: "Ask about parser",
      kind: "conversation",
      createdBy: "claude-1",
      participants: ["claude-1", "codex-1"],
      owner: "claude-1",
      waitingOn: ["codex-1"],
      status: "waiting",
    });
    const updated = threads.setThreadStatus(thread.id, "done", { owner: "claude-1" });
    return { result: { thread: updated }, exchange: storeSnapshot() };
  },
);

await add(
  "opens and reuses direct conversation threads",
  "orchestration",
  "direct-reuse",
  [
    {
      route: "/threads/send",
      body: {
        from: "user",
        to: ["codex-1"],
        body: "Please review the parser change.",
        title: "Parser review",
      },
      save: "first",
    },
    {
      route: "/threads/send",
      body: {
        from: "user",
        to: ["codex-1"],
        body: "Any update?",
      },
    },
  ],
  () => {
    const first = orchestration.sendDirectMessage({
      from: "user",
      to: ["codex-1"],
      body: "Please review the parser change.",
      title: "Parser review",
    });
    const second = orchestration.sendDirectMessage({
      from: "user",
      to: ["codex-1"],
      body: "Any update?",
    });
    return { result: { first, second }, exchange: storeSnapshot() };
  },
);

await add(
  "marks replies as waiting on the next recipients",
  "orchestration",
  "thread-reply",
  [
    {
      route: "/threads/send",
      body: {
        from: "claude-lead",
        to: ["codex-1"],
        body: "Take the next debugging pass.",
      },
      save: "created",
    },
    {
      route: "/threads/send",
      body: {
        threadIdFrom: "created.thread.id",
        from: "codex-1",
        to: ["claude-lead"],
        kind: "reply",
        body: "I found the root cause. Can you confirm the rollout plan?",
      },
    },
  ],
  () => {
    const created = orchestration.sendDirectMessage({
      from: "claude-lead",
      to: ["codex-1"],
      body: "Take the next debugging pass.",
    });
    const replied = orchestration.sendThreadMessage({
      threadId: created.thread.id,
      from: "codex-1",
      to: ["claude-lead"],
      kind: "reply",
      body: "I found the root cause. Can you confirm the rollout plan?",
    });
    return { result: { created, replied }, exchange: storeSnapshot() };
  },
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/threads.test.ts, src/orchestration.test.ts",
  generatedBy: "scripts/capture-coordination-mutations-contract.mjs",
  description:
    "Thread and direct-message mutation contracts captured by running TypeScript threads/orchestration helpers, including runtime-exchange side effects.",
  normalization: {
    ids: "Generated thread/message ids are tokenized in first-appearance order.",
    timestamps: "ISO timestamps are replaced with <ts> after per-object monotonicity checks.",
  },
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
