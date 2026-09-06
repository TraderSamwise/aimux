#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/interaction-requests/registry.json", ROOT);

const { InteractionRegistry } = await import(new URL("dist/interaction-requests.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function normalize(value, ids = new Map(), timestamps = new Map()) {
  if (Array.isArray(value)) return value.map((item) => normalize(item, ids, timestamps));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, normalize(nested, ids, timestamps)]));
  }
  if (typeof value !== "string") return value;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    if (!ids.has(value)) ids.set(value, `<id:${ids.size + 1}>`);
    return ids.get(value);
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    if (!timestamps.has(value)) timestamps.set(value, `<ts:${timestamps.size + 1}>`);
    return timestamps.get(value);
  }
  return value;
}

async function runScenario(input) {
  const registry = new InteractionRegistry(input.options ?? {});
  const outputs = [];
  const ids = new Map();
  for (const op of input.ops) {
    if (op.op === "register") {
      const request = registry.register(op.input);
      outputs.push({ op: "register", request, sameAs: op.sameAs ? request.id === ids.get(op.sameAs) : undefined });
      if (op.saveAs) ids.set(op.saveAs, request.id);
    } else if (op.op === "get") {
      outputs.push({ op: "get", request: registry.get(ids.get(op.id) ?? op.id) ?? null });
    } else if (op.op === "listPending") {
      outputs.push({ op: "listPending", requests: registry.listPending(op.sessionId) });
    } else if (op.op === "resolve") {
      outputs.push({ op: "resolve", request: registry.resolve(ids.get(op.id) ?? op.id, op.response) ?? null });
    } else if (op.op === "cancel") {
      outputs.push({ op: "cancel", request: registry.cancel(ids.get(op.id) ?? op.id) ?? null });
    } else if (op.op === "cancelSession") {
      registry.cancelSession(op.sessionId);
      outputs.push({ op: "cancelSession", pending: registry.listPending() });
    } else if (op.op === "waitResolved") {
      const request = registry.register(op.input);
      ids.set(op.saveAs, request.id);
      registry.resolve(request.id, op.response);
      outputs.push({ op: "waitResolved", request: await registry.wait(request.id, { timeoutMs: 1000 }) });
    } else if (op.op === "waitTimeout") {
      const request = registry.register(op.input);
      ids.set(op.saveAs, request.id);
      const waiting = registry.wait(request.id, { timeoutMs: op.timeoutMs });
      await sleep(op.timeoutMs + 5);
      outputs.push({ op: "waitTimeout", request: await waiting });
    } else if (op.op === "sleep") {
      await sleep(op.ms);
      outputs.push({ op: "sleep", ms: op.ms });
    }
  }
  return normalize(outputs);
}

const scenarios = [
  {
    name: "registers generated and supplied ids",
    input: {
      ops: [
        {
          op: "register",
          saveAs: "generated",
          input: { sessionId: "s1", type: "permission", payload: { toolName: "Bash" } },
        },
        { op: "get", id: "generated" },
        { op: "register", input: { id: "fixed", sessionId: "s1", type: "input", payload: {} } },
      ],
    },
  },
  {
    name: "dedupes pending requests by dedupe key",
    input: {
      ops: [
        {
          op: "register",
          saveAs: "first",
          input: { id: "first", sessionId: "s1", type: "question", dedupeKey: "same", payload: { question: "?" } },
        },
        {
          op: "register",
          sameAs: "first",
          input: { id: "second", sessionId: "s1", type: "question", dedupeKey: "same", payload: { question: "different" } },
        },
      ],
    },
  },
  {
    name: "lists only pending requests filtered by session",
    input: {
      ops: [
        { op: "register", saveAs: "a", input: { id: "a", sessionId: "s1", type: "permission", payload: { toolName: "Bash" } } },
        { op: "register", input: { id: "b", sessionId: "s2", type: "permission", payload: { toolName: "Edit" } } },
        { op: "resolve", id: "a", response: { decision: "allow_once" } },
        { op: "listPending" },
        { op: "listPending", sessionId: "s1" },
      ],
    },
  },
  {
    name: "double resolve keeps the first decision",
    input: {
      ops: [
        { op: "register", saveAs: "req", input: { id: "fixed", sessionId: "s1", type: "permission", payload: { toolName: "Bash" } } },
        { op: "resolve", id: "req", response: { decision: "allow_once" } },
        { op: "resolve", id: "req", response: { decision: "deny" } },
        { op: "get", id: "req" },
      ],
    },
  },
  {
    name: "cancel session cancels only matching pending requests",
    input: {
      ops: [
        { op: "register", input: { id: "a", sessionId: "s1", type: "permission", payload: { toolName: "Bash" } } },
        { op: "register", input: { id: "b", sessionId: "s1", type: "input", payload: {} } },
        { op: "register", input: { id: "c", sessionId: "s2", type: "input", payload: {} } },
        { op: "cancelSession", sessionId: "s1" },
        { op: "listPending" },
      ],
    },
  },
  {
    name: "wait returns immediately when already resolved",
    input: {
      ops: [
        {
          op: "waitResolved",
          saveAs: "req",
          input: { id: "resolved", sessionId: "s1", type: "permission", payload: { toolName: "Bash" } },
          response: { decision: "allow_always" },
        },
      ],
    },
  },
  {
    name: "wait times out and marks the request timed out",
    input: {
      ops: [
        { op: "waitTimeout", saveAs: "req", timeoutMs: 1, input: { id: "timeout", sessionId: "s1", type: "permission", payload: { toolName: "Bash" } } },
        { op: "get", id: "req" },
        { op: "listPending" },
      ],
    },
  },
];

const cases = [];
for (const [index, scenario] of scenarios.entries()) {
  cases.push({
    id: `interaction-requests-${String(index + 1).padStart(3, "0")}`,
    name: scenario.name,
    source: "src/interaction-requests.test.ts",
    api: "InteractionRegistry",
    input: scenario.input,
    output: await runScenario(scenario.input),
    inputSha256: hash(scenario.input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/interaction-requests.test.ts",
  generatedBy: "scripts/capture-interaction-requests-contract.mjs",
  description:
    "InteractionRegistry registration, dedupe, pending filters, resolve/cancel, wait-immediate, and timeout behavior captured by running TypeScript with generated ids and timestamps normalized.",
  normalization: {
    ids: "Generated UUIDs are replaced with <id:n> in first-appearance order.",
    timestamps: "ISO timestamps are replaced with <ts:n> in first-appearance order.",
  },
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
