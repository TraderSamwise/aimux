#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/metadata-watchers/builtin.json", ROOT);

const paths = await import(new URL("dist/paths.js", ROOT));
const { createBuiltinMetadataWatchers } = await import(new URL("dist/builtin-metadata-watchers.js", ROOT));
const { createRuntimeExchangeStore, emptyRuntimeExchange } = await import(
  new URL("dist/runtime-core/exchange-store.js", ROOT)
);
const { appendTurn } = await import(new URL("dist/context/history.js", ROOT));
const { writePlanContent } = await import(new URL("dist/runtime-core/plan-authority.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

const cases = [];
function record(name, input, output) {
  cases.push({
    id: `metadata-watchers-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/builtin-metadata-watchers.test.ts",
    api: "createBuiltinMetadataWatchers",
    input,
    output,
    inputSha256: hash(input),
  });
}

function emptyCalls() {
  return { statuses: [], progresses: [], logs: [], contexts: [], events: [] };
}

async function runWatcherScenario(input) {
  const tempRoot = mkdtempSync(join(tmpdir(), "aimux-metadata-watchers-contract-"));
  const previousHome = process.env.AIMUX_HOME;
  process.env.AIMUX_HOME = join(tempRoot, ".aimux");
  const repoRoot = join(tempRoot, "repo");
  mkdirSync(join(repoRoot, ".git"), { recursive: true });
  try {
    await paths.initPaths(repoRoot);
    for (const [sessionId, text] of Object.entries(input.statusFiles ?? {})) {
      mkdirSync(paths.getStatusDir(), { recursive: true });
      writeFileSync(join(paths.getStatusDir(), `${sessionId}.md`), text);
    }
    for (const [sessionId, text] of Object.entries(input.planFiles ?? {})) {
      writePlanContent(sessionId, text);
    }
    for (const [sessionId, turns] of Object.entries(input.history ?? {})) {
      for (const turn of turns) appendTurn(sessionId, turn);
    }
    createRuntimeExchangeStore().write(input.exchange ?? emptyRuntimeExchange("2026-08-25T00:00:00.000Z"));

    const calls = emptyCalls();
    const watchers = createBuiltinMetadataWatchers({
      projectRoot: repoRoot,
      projectId: "proj",
      serverHost: "127.0.0.1",
      serverPort: 43000,
      metadata: {
        setStatus(session, text, tone) {
          calls.statuses.push([session, text, tone]);
        },
        setProgress(session, current, total, label) {
          calls.progresses.push([session, current, total, label]);
        },
        log(session, message, opts) {
          calls.logs.push([session, message, opts?.source, opts?.tone]);
        },
        clearLog() {},
        setContext(session, context) {
          calls.contexts.push([session, context.worktreeName, context.branch, context.pr?.number]);
        },
        emitEvent(session, event) {
          calls.events.push([session, event.kind, event.message, event.source, event.tone, event.ts]);
        },
        markSeen() {},
        setActivity() {},
        setAttention() {},
      },
      sessions: {
        list: () => (input.sessions ?? []).map((id) => ({ id })),
      },
    });
    for (const watcher of watchers) watcher.start?.();

    if (input.waitAfterStartMs) await sleep(input.waitAfterStartMs);
    for (const operation of input.afterStart ?? []) {
      if (operation.op === "writeExchange") createRuntimeExchangeStore().write(operation.exchange);
      if (operation.op === "appendTurn") appendTurn(operation.sessionId, operation.turn);
      if (operation.op === "wait") await sleep(operation.ms);
    }
    for (const watcher of watchers) await watcher.stop?.();
    return calls;
  } finally {
    if (previousHome === undefined) {
      delete process.env.AIMUX_HOME;
    } else {
      process.env.AIMUX_HOME = previousHome;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

const baseExchange = emptyRuntimeExchange("2026-08-25T00:00:00.000Z");

for (const [name, input] of [
  [
    "loads initial status and plan progress",
    {
      sessions: ["s1"],
      statusFiles: { s1: "Working through auth\nmore" },
      planFiles: { s1: ["# Plan", "", "- [x] inspect", "- [ ] patch", "- [ ] test"].join("\n") },
      exchange: baseExchange,
    },
  ],
  [
    "does not rewrite unchanged status and plan progress on every poll",
    {
      sessions: ["s1"],
      statusFiles: { s1: "Still working\n" },
      planFiles: { s1: ["- [x] inspect", "- [ ] patch"].join("\n") },
      exchange: baseExchange,
      waitAfterStartMs: 2300,
    },
  ],
  [
    "primes initial task and history metadata without replaying logs or events",
    {
      sessions: ["s1"],
      exchange: {
        ...baseExchange,
        tasks: [
          {
            id: "t1",
            status: "assigned",
            assignedBy: "leader",
            assignedTo: "s1",
            description: "Ship auth",
            prompt: "do it",
            createdAt: "2026-08-25T00:00:00.000Z",
            updatedAt: "2026-08-25T00:00:00.000Z",
          },
        ],
      },
      history: {
        s1: [{ ts: "2026-08-25T00:00:00.000Z", type: "prompt", content: "Explain auth flow" }],
      },
    },
  ],
  [
    "logs and emits new task and history updates after startup priming",
    {
      sessions: ["s1"],
      exchange: baseExchange,
      history: {
        s1: [{ ts: "2026-01-01T00:00:00.000Z", type: "prompt", content: "Existing prompt" }],
      },
      afterStart: [
        {
          op: "writeExchange",
          exchange: {
            ...baseExchange,
            tasks: [
              {
                id: "t2",
                status: "done",
                assignedBy: "leader",
                assignedTo: "s2",
                description: "Finish repair",
                prompt: "do it",
                result: "done",
                createdAt: "2026-08-25T00:00:00.000Z",
                updatedAt: "2026-08-25T00:00:00.000Z",
              },
            ],
          },
        },
        {
          op: "appendTurn",
          sessionId: "s1",
          turn: { ts: "2026-01-01T00:00:01.000Z", type: "response", content: "Repair finished" },
        },
        { op: "wait", ms: 2300 },
      ],
    },
  ],
  [
    "does not scan history for sessions outside live topology",
    {
      sessions: [],
      exchange: baseExchange,
      history: {
        "old-agent": [{ ts: "2026-01-01T00:00:00.000Z", type: "response", content: "Old response" }],
      },
      afterStart: [
        {
          op: "appendTurn",
          sessionId: "old-agent",
          turn: { ts: "2026-01-01T00:00:01.000Z", type: "response", content: "Ignored response" },
        },
        { op: "wait", ms: 2300 },
      ],
    },
  ],
]) {
  record(name, input, await runWatcherScenario(input));
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/builtin-metadata-watchers.test.ts",
  generatedBy: "scripts/capture-builtin-metadata-watchers-contract.mjs",
  description:
    "Builtin metadata watcher status, plan progress, task, and history metadata side-effect contracts captured by running TypeScript createBuiltinMetadataWatchers against temporary project state.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
