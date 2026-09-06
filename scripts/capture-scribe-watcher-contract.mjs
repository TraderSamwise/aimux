#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/coordination/scribe-watcher.json", ROOT);
const scribe = await import(new URL("dist/scribe-watcher.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function metadata(sessions) {
  return { version: 1, sessions };
}

function makeSession(id, override = {}) {
  return { id, status: "running", tool: "codex", ...override };
}

const updatedAt = "2026-08-30T00:00:00.000Z";
const normalMeta = (activity = "idle", attention = "normal", extra = {}) => ({
  derived: { activity, attention },
  updatedAt,
  ...extra,
});
const scribeMeta = (extra = {}) => ({ scribe: true, updatedAt, ...extra });

function baseWatcherInput(extra = {}) {
  return {
    source: "src/scribe-watcher.test.ts",
    api: "ScribeWatcher.scan",
    sessions: [makeSession("scribe"), makeSession("agent-1")],
    metadata: metadata({
      scribe: scribeMeta({ derived: { activity: "idle", attention: "normal" } }),
      "agent-1": normalMeta("idle"),
    }),
    readOutputs: { "agent-1": "agent finished docs" },
    ops: [{ kind: "scan" }],
    ...extra,
  };
}

function outputFor(input, sessionId) {
  const source = input.readOutputs ?? {};
  const value = Object.prototype.hasOwnProperty.call(source, sessionId) ? source[sessionId] : "";
  return value;
}

async function scanScenario(input) {
  let now = input.now ?? 10_000;
  let activeSessionId = input.activeSessionId;
  const readCalls = [];
  const sendCalls = [];
  const watcher = new scribe.ScribeWatcher({
    loadSessions: () => {
      if (!activeSessionId) return input.sessions;
      return [makeSession("scribe"), makeSession(activeSessionId)];
    },
    loadMetadata: () => {
      if (!activeSessionId) return input.metadata;
      return metadata({
        scribe: scribeMeta({ derived: { activity: "idle", attention: "normal" } }),
        [activeSessionId]: normalMeta("idle"),
      });
    },
    readAgentOutput: async (sessionId, startLine) => {
      readCalls.push({ sessionId, startLine });
      if ((input.readFailures ?? []).includes(sessionId)) throw new Error("pane gone");
      return outputFor(input, sessionId);
    },
    sendAgentInput: async (sessionId, text) => {
      sendCalls.push({ sessionId, text });
    },
    now: () => now,
    scanIntervalMs: input.scanIntervalMs,
    cooldownMs: input.cooldownMs,
    maxCandidates: input.maxCandidates,
    maxScanCandidates: input.maxScanCandidates,
    maxOutputChars: input.maxOutputChars,
    maxBriefingChars: input.maxBriefingChars,
    outputStartLine: input.outputStartLine,
  });

  if (input.stopDuringRead) {
    let resolveRead;
    const stoppedReadCalls = [];
    const stoppedSendCalls = [];
    const stoppedWatcher = new scribe.ScribeWatcher({
      loadSessions: () => input.sessions,
      loadMetadata: () => input.metadata,
      readAgentOutput: (sessionId, startLine) => {
        stoppedReadCalls.push({ sessionId, startLine });
        return new Promise((resolve) => {
          resolveRead = resolve;
        });
      },
      sendAgentInput: async (sessionId, text) => {
        stoppedSendCalls.push({ sessionId, text });
      },
      now: () => now,
      cooldownMs: input.cooldownMs,
    });
    const scan = stoppedWatcher.scan();
    stoppedWatcher.stop();
    resolveRead(input.stopDuringRead.output);
    await scan;
    return [{ kind: "stopDuringRead", readCalls: stoppedReadCalls, sendCalls: stoppedSendCalls }];
  }

  const outputs = [];
  for (const op of input.ops ?? [{ kind: "scan" }]) {
    if (op.kind === "advance") {
      now += op.ms;
      outputs.push({ kind: "advance", now });
    } else if (op.kind === "setActiveSession") {
      activeSessionId = op.sessionId;
      outputs.push({ kind: "setActiveSession", sessionId: activeSessionId });
    } else if (op.kind === "scan") {
      await watcher.scan();
      outputs.push({ kind: "scan", readCalls: [...readCalls], sendCalls: [...sendCalls] });
    } else {
      throw new Error(`unknown op ${op.kind}`);
    }
  }
  return outputs;
}

async function run(input) {
  switch (input.api) {
    case "findScribeCandidates":
      return scribe.findScribeCandidates(input.sessions, input.metadata, input.scribeId, input.maxScanCandidates);
    case "findScribeCandidateIds":
      return scribe
        .findScribeCandidates(input.sessions, input.metadata, input.scribeId, input.maxScanCandidates)
        .map((candidate) => candidate.id);
    case "buildScribeBriefing":
      return scribe.buildScribeBriefing(input.candidates);
    case "ScribeWatcher.scan":
      return scanScenario(input);
    default:
      throw new Error(`unknown api ${input.api}`);
  }
}

const candidate = {
  id: "codex-1",
  tool: "codex",
  status: "running",
  activity: "idle",
  attention: "normal",
  worktreePath: "/repo/.aimux/worktrees/task",
  output: "Implemented parser tests.\n",
  outputChars: 26,
  fingerprint: "abc",
};

const candidateSessions = [
  makeSession("scribe"),
  makeSession("overseer"),
  makeSession("idle-agent"),
  makeSession("done-agent", { status: "idle" }),
  makeSession("busy-agent"),
  makeSession("needs-input"),
];
const manySessions = Array.from({ length: 5 }, (_, index) => makeSession(`agent-${index}`));
const cappedSessions = [
  makeSession("scribe"),
  ...Array.from({ length: 6 }, (_, index) => makeSession(`agent-${index}`)),
];
const unchangedLaterSessions = [
  makeSession("scribe"),
  ...Array.from({ length: scribe.SCRIBE_WATCHER_MAX_CANDIDATES }, (_, index) => makeSession(`unchanged-${index}`)),
  makeSession("changed-later"),
];

const inputs = [
  {
    name: "finds bounded idle/done normal sessions and skips project control sessions",
    source: "src/scribe-watcher.test.ts",
    api: "findScribeCandidates",
    sessions: candidateSessions,
    scribeId: "scribe",
    metadata: metadata({
      scribe: scribeMeta(),
      overseer: { overseer: true, updatedAt },
      "idle-agent": normalMeta("idle", "normal", { context: { worktreePath: "/repo/.aimux/worktrees/feature" } }),
      "done-agent": normalMeta("done"),
      "busy-agent": normalMeta("working"),
      "needs-input": normalMeta("idle", "needs_response"),
    }),
  },
  {
    name: "honors max candidates",
    source: "src/scribe-watcher.test.ts",
    api: "findScribeCandidateIds",
    sessions: manySessions,
    maxScanCandidates: 2,
    metadata: metadata(Object.fromEntries(manySessions.map((session) => [session.id, normalMeta("idle")]))),
  },
  {
    name: "renders changed bounded tails with ids and worktrees",
    source: "src/scribe-watcher.test.ts",
    api: "buildScribeBriefing",
    candidates: [candidate],
  },
  baseWatcherInput({
    name: "scans immediately when started",
    metadata: metadata({
      scribe: scribeMeta({ derived: { activity: "idle", attention: "normal" } }),
      "agent-1": normalMeta("done"),
    }),
    readOutputs: { "agent-1": "agent finished setup" },
    scanIntervalMs: 60_000,
  }),
  baseWatcherInput({
    name: "does nothing without a live scribe",
    sessions: [makeSession("agent-1")],
    metadata: metadata({ "agent-1": normalMeta("idle") }),
  }),
  baseWatcherInput({
    name: "sends one bounded briefing for changed candidate output",
    sessions: [makeSession("scribe"), makeSession("agent-1", { worktreePath: "/repo/task" })],
    metadata: metadata({
      scribe: scribeMeta({ derived: { activity: "idle", attention: "normal" } }),
      "agent-1": normalMeta("done"),
    }),
    readOutputs: { "agent-1": { output: `${"x".repeat(scribe.SCRIBE_WATCHER_MAX_OUTPUT_CHARS + 20)}meaningful tail` } },
  }),
  baseWatcherInput({
    name: "caps each automatic briefing even when many agents changed",
    sessions: cappedSessions,
    metadata: metadata({
      scribe: scribeMeta({ derived: { activity: "idle", attention: "normal" } }),
      ...Object.fromEntries(
        cappedSessions
          .filter((session) => session.id !== "scribe")
          .map((session) => [session.id, normalMeta("idle")]),
      ),
    }),
    readOutputs: Object.fromEntries(
      cappedSessions
        .filter((session) => session.id !== "scribe")
        .map((session) => [session.id, `${session.id} ${"work ".repeat(80)}`]),
    ),
    maxCandidates: 6,
    maxBriefingChars: 1_500,
  }),
  baseWatcherInput({
    name: "does not resend unchanged fingerprints after cooldown",
    readOutputs: { "agent-1": "same output" },
    cooldownMs: 1,
    ops: [{ kind: "scan" }, { kind: "advance", ms: 2 }, { kind: "scan" }],
  }),
  baseWatcherInput({
    name: "keeps scanning other candidates when one read fails",
    sessions: [makeSession("scribe"), makeSession("agent-1"), makeSession("agent-2")],
    metadata: metadata({
      scribe: scribeMeta({ derived: { activity: "idle", attention: "normal" } }),
      "agent-1": normalMeta("idle"),
      "agent-2": normalMeta("idle"),
    }),
    readOutputs: { "agent-2": { output: "agent two finished docs" } },
    readFailures: ["agent-1"],
  }),
  baseWatcherInput({
    name: "skips sends while the scribe is busy",
    metadata: metadata({
      scribe: scribeMeta({ derived: { activity: "working", attention: "normal" } }),
      "agent-1": normalMeta("idle"),
    }),
  }),
  baseWatcherInput({
    name: "allows a live scribe before derived activity has been parsed",
    metadata: metadata({
      scribe: scribeMeta(),
      "agent-1": normalMeta("done"),
    }),
  }),
  baseWatcherInput({
    name: "continues past unchanged early candidates before applying delivery cap",
    sessions: unchangedLaterSessions,
    metadata: metadata({
      scribe: scribeMeta({ derived: { activity: "idle", attention: "normal" } }),
      ...Object.fromEntries(
        unchangedLaterSessions
          .filter((session) => session.id !== "scribe")
          .map((session) => [session.id, normalMeta("idle")]),
      ),
    }),
    readOutputs: Object.fromEntries(
      unchangedLaterSessions
        .filter((session) => session.id !== "scribe")
        .map((session) => [session.id, session.id === "changed-later" ? "new later work" : "same noise"]),
    ),
    cooldownMs: 1,
    maxCandidates: scribe.SCRIBE_WATCHER_MAX_CANDIDATES,
    ops: [{ kind: "scan" }, { kind: "advance", ms: 2 }, { kind: "scan" }],
  }),
  baseWatcherInput({
    name: "does not deliver an in-flight scan after stop",
    stopDuringRead: { output: "work after shutdown" },
  }),
  baseWatcherInput({
    name: "forgets fingerprints for sessions that leave the active candidate set",
    activeSessionId: "agent-1",
    readOutputs: { "agent-1": "same output", "agent-2": "same output" },
    cooldownMs: 1,
    ops: [
      { kind: "scan" },
      { kind: "advance", ms: 2 },
      { kind: "setActiveSession", sessionId: "agent-2" },
      { kind: "scan" },
      { kind: "advance", ms: 2 },
      { kind: "setActiveSession", sessionId: "agent-1" },
      { kind: "scan" },
    ],
  }),
];

const cases = [];
for (const input of inputs) {
  cases.push({
    id: `scribe-watcher-${String(cases.length + 1).padStart(3, "0")}`,
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
  source: ["src/scribe-watcher.test.ts"],
  generatedBy: "scripts/capture-scribe-watcher-contract.mjs",
  description:
    "Scribe watcher candidate selection, readiness gates, output reads, bounded briefing construction, fingerprint cooldown, stop, and active-candidate pruning captured by running the TypeScript implementation.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
