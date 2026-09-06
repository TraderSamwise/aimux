#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/coordination/loop-watcher.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const loop = await import(new URL("dist/loop-watcher.js", ROOT));

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function meta(input = {}) {
  return { updatedAt: "2026-06-13T00:00:00.000Z", ...input };
}

function derived(activity, attention = "normal", loopExtra = {}) {
  return meta({
    loop: {
      active: true,
      goal: "ship it",
      since: "2026-06-13T00:00:00.000Z",
      source: "dashboard",
      updatedBy: "dashboard",
      ...loopExtra,
    },
    derived: { activity, attention },
  });
}

function state(sessions) {
  return { version: 1, sessions };
}

const baseSessions = [{ id: "a", status: "running", tool: "claude", worktreePath: "/wt/a" }];
const baseConfig = { scanIntervalMs: 15000, nudgeCooldownMs: 60000, autoNudgeWithoutOverseer: false };

async function scanScenario(input) {
  let now = input.now ?? 1_000_000;
  const sends = [];
  const watcher = new loop.LoopWatcher({
    config: input.config ?? baseConfig,
    loadSessions: () => input.sessions,
    loadMetadata: () => input.metadata,
    hasPendingInteraction: (sessionId) => (input.pendingInteractions ?? []).includes(sessionId),
    now: () => now,
    sendAgentInput: async (sessionId, text) => {
      sends.push({ sessionId, text });
      if ((input.sendFailures ?? []).includes(sessionId)) throw new Error("session not running");
      return {};
    },
  });
  const outputs = [];
  for (const op of input.ops ?? [{ kind: "scan" }]) {
    if (op.kind === "advance") {
      now += op.ms;
      outputs.push({ kind: "advance", now });
    } else if (op.kind === "scan") {
      await watcher.scan();
      outputs.push({ kind: "scan", sends: [...sends] });
    }
  }
  return outputs;
}

async function run(input) {
  switch (input.api) {
    case "findLoopCandidates":
      return loop.findLoopCandidates(input.sessions, input.metadata, {
        overseerId: input.overseerId,
        hasPendingInteraction: (sessionId) => (input.pendingInteractions ?? []).includes(sessionId),
      });
    case "buildOverseerBriefing":
      return loop.buildOverseerBriefing(input.candidates, input.template);
    case "LoopWatcher.scan":
      return scanScenario(input);
    default:
      throw new Error(`unknown api ${input.api}`);
  }
}

const candidate = {
  id: "a",
  tool: "claude",
  worktreePath: "/wt/a",
  loopSince: "2026-06-13T00:00:00.000Z",
  loopSource: "dashboard",
  loopUpdatedBy: "dashboard",
};

const inputs = [
  { name: "flags in-loop idle agents with normal attention", source: "src/loop-watcher.test.ts", api: "findLoopCandidates", sessions: baseSessions, metadata: state({ a: derived("idle") }) },
  { name: "flags in-loop done agents", source: "src/loop-watcher.test.ts", api: "findLoopCandidates", sessions: baseSessions, metadata: state({ a: derived("done") }) },
  { name: "ignores agents that are still working", source: "src/loop-watcher.test.ts", api: "findLoopCandidates", sessions: baseSessions, metadata: state({ a: derived("running") }) },
  { name: "ignores agents waiting on a human", source: "src/loop-watcher.test.ts", api: "findLoopCandidates", sessions: baseSessions, metadata: state({ a: derived("idle", "needs_response") }) },
  { name: "ignores agents not marked in a loop", source: "src/loop-watcher.test.ts", api: "findLoopCandidates", sessions: baseSessions, metadata: state({ a: meta({ derived: { activity: "idle" } }) }) },
  { name: "ignores the overseer itself", source: "src/loop-watcher.test.ts", api: "findLoopCandidates", sessions: baseSessions, metadata: state({ a: derived("idle") }), overseerId: "a" },
  { name: "ignores agents with pending interactions", source: "src/loop-watcher.test.ts", api: "findLoopCandidates", sessions: baseSessions, metadata: state({ a: derived("idle") }), pendingInteractions: ["a"] },
  { name: "builds default overseer briefing", source: "src/loop-watcher.test.ts", api: "buildOverseerBriefing", candidates: [candidate] },
  { name: "renders custom overseer briefing template", source: "src/loop-watcher.test.ts", api: "buildOverseerBriefing", candidates: [candidate], template: "Loop check: {{count}}\n{{candidates}}\nUse my project-specific policy." },
  { name: "wakes running overseer respecting cooldown", source: "src/loop-watcher.test.ts", api: "LoopWatcher.scan", sessions: [...baseSessions, { id: "boss", status: "running" }], metadata: state({ a: derived("idle"), boss: meta({ overseer: true }) }), ops: [{ kind: "scan" }, { kind: "scan" }, { kind: "advance", ms: 60001 }, { kind: "scan" }] },
  { name: "uses configured overseer briefing template", source: "src/loop-watcher.test.ts", api: "LoopWatcher.scan", sessions: [...baseSessions, { id: "boss", status: "running" }], metadata: state({ a: derived("idle"), boss: meta({ overseer: true }) }), config: { ...baseConfig, overseerBriefingTemplate: "Custom loop copy for {{count}}:\n{{candidates}}" } },
  { name: "does nothing without overseer when auto-nudge is off", source: "src/loop-watcher.test.ts", api: "LoopWatcher.scan", sessions: baseSessions, metadata: state({ a: derived("idle") }) },
  { name: "auto-nudges when overseer metadata is offline and auto-nudge is on", source: "src/loop-watcher.test.ts", api: "LoopWatcher.scan", sessions: baseSessions, metadata: state({ a: derived("idle"), boss: meta({ overseer: true }) }), config: { ...baseConfig, autoNudgeWithoutOverseer: true } },
  { name: "sends canned nudge respecting cooldown", source: "src/loop-watcher.test.ts", api: "LoopWatcher.scan", sessions: baseSessions, metadata: state({ a: derived("idle") }), config: { ...baseConfig, autoNudgeWithoutOverseer: true }, ops: [{ kind: "scan" }, { kind: "scan" }, { kind: "advance", ms: 60001 }, { kind: "scan" }] },
  { name: "does not consume cooldown when nudge send fails", source: "src/loop-watcher.test.ts", api: "LoopWatcher.scan", sessions: baseSessions, metadata: state({ a: derived("idle") }), config: { ...baseConfig, autoNudgeWithoutOverseer: true }, sendFailures: ["a"], ops: [{ kind: "scan" }, { kind: "scan" }] },
];

const cases = [];
for (const input of inputs) {
  cases.push({
    id: `loop-watcher-${String(cases.length + 1).padStart(3, "0")}`,
    name: input.name,
    source: input.source,
    api: input.api,
    input,
    output: await run(input),
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: ["src/loop-watcher.test.ts"],
  generatedBy: "scripts/capture-loop-watcher-contract.mjs",
  description:
    "Loop watcher candidate selection, overseer briefing rendering, scan cooldown, auto-nudge, and failed-send retry behavior captured by running TypeScript loop-watcher helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
