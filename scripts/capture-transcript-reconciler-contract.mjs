#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/agent-output/transcript-reconciler.json", ROOT);

const { TranscriptReconciler } = await import(new URL("dist/multiplexer/transcript-reconciler.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));

const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

function session(id, over = {}) {
  return {
    id,
    tool: "claude",
    toolConfigKey: "claude",
    command: "claude",
    args: [],
    status: "running",
    backendSessionId: `be-${id}`,
    worktreePath: `/wt/${id}`,
    ...over,
  };
}

function metadata(id, derived, context = { transcriptPath: `/t/${id}.jsonl` }) {
  return { version: 1, sessions: { [id]: { updatedAt: "now", derived, context } } };
}

function createRecorder(overrides = {}) {
  const calls = {
    settleActivity: [],
    clearStaleResponse: [],
    probe: [],
    findCodexPath: [],
    hasPendingInteraction: [],
  };
  const state = {
    metadata: overrides.metadata ?? metadata("a", { activity: "running", attention: "normal" }),
    sessions: overrides.sessions ?? [session("a")],
    pendingInteraction: overrides.pendingInteraction ?? false,
    probe: overrides.probe ?? { turn: "complete", size: 10, mtimeMs: 1 },
    findCodexPath: overrides.findCodexPath ?? null,
  };
  const deps = {
    loadMetadata: () => (typeof state.metadata === "function" ? state.metadata() : state.metadata),
    loadSessions: () => (typeof state.sessions === "function" ? state.sessions() : state.sessions),
    hasPendingInteraction: (sessionId) => {
      calls.hasPendingInteraction.push([sessionId]);
      return typeof state.pendingInteraction === "function"
        ? state.pendingInteraction(sessionId)
        : state.pendingInteraction;
    },
    settleActivity: (sessionId) => calls.settleActivity.push([sessionId]),
    clearStaleResponse: (sessionId) => calls.clearStaleResponse.push([sessionId]),
    probe: (toolConfigKey, path) => {
      calls.probe.push([toolConfigKey, path]);
      return typeof state.probe === "function" ? state.probe(toolConfigKey, path) : state.probe;
    },
    findCodexPath: (backendSessionId) => {
      calls.findCodexPath.push([backendSessionId]);
      return typeof state.findCodexPath === "function" ? state.findCodexPath(backendSessionId) : state.findCodexPath;
    },
  };
  return { reconciler: new TranscriptReconciler(deps), calls, state };
}

const cases = [];
function record(name, input, run) {
  const output = run();
  cases.push({
    id: `agent-output-transcript-reconciler-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/multiplexer/transcript-reconciler.test.ts",
    sourceName: name,
    api: "TranscriptReconciler.scan",
    input,
    output,
    inputSha256: hash(input),
  });
}

record(
  "settles only after the transcript is complete AND quiescent across two ticks",
  { ticks: 2, probe: { turn: "complete", size: 10, mtimeMs: 1 } },
  () => {
    const { reconciler, calls } = createRecorder();
    reconciler.scan();
    const afterFirst = clone(calls);
    reconciler.scan();
    return { afterFirst, calls };
  },
);

record(
  "does not settle while the transcript is still being written (size changes)",
  { ticks: 3, probe: "size-increments" },
  () => {
    let size = 10;
    const { reconciler, calls } = createRecorder({ probe: () => ({ turn: "complete", size: size++, mtimeMs: size }) });
    reconciler.scan();
    reconciler.scan();
    reconciler.scan();
    return { calls };
  },
);

record(
  "never settles a mid-turn (in_progress) transcript",
  { ticks: 2, probe: { turn: "in_progress", size: 10, mtimeMs: 1 } },
  () => {
    const { reconciler, calls } = createRecorder({ probe: { turn: "in_progress", size: 10, mtimeMs: 1 } });
    reconciler.scan();
    reconciler.scan();
    return { calls };
  },
);

record(
  "ignores a genuinely idle agent (activity not running/waiting)",
  { ticks: 2, derived: { activity: "idle", attention: "normal" } },
  () => {
    const { reconciler, calls } = createRecorder({
      metadata: metadata("a", { activity: "idle", attention: "normal" }),
    });
    reconciler.scan();
    reconciler.scan();
    return { calls };
  },
);

record(
  "does not touch a needs_input agent (attention not normal)",
  { ticks: 2, derived: { activity: "waiting", attention: "needs_input" } },
  () => {
    const { reconciler, calls } = createRecorder({
      metadata: metadata("a", { activity: "waiting", attention: "needs_input" }),
    });
    reconciler.scan();
    reconciler.scan();
    return { calls };
  },
);

record(
  "settles a stuck waiting+normal agent (decoupled pair) too",
  { ticks: 2, derived: { activity: "waiting", attention: "normal" } },
  () => {
    const { reconciler, calls } = createRecorder({
      metadata: metadata("a", { activity: "waiting", attention: "normal" }),
    });
    reconciler.scan();
    reconciler.scan();
    return { calls };
  },
);

record(
  "skips sessions with no resolvable transcript path",
  { ticks: 2, context: {}, session: { backendSessionId: undefined } },
  () => {
    const { reconciler, calls } = createRecorder({
      metadata: metadata("a", { activity: "running", attention: "normal" }, {}),
      sessions: [session("a", { backendSessionId: undefined })],
    });
    reconciler.scan();
    reconciler.scan();
    return { calls };
  },
);

record(
  "caches the resolved codex path while live and re-resolves after the session leaves",
  { ticks: ["live", "live", "gone", "live"], codexPath: "/codex/x.jsonl" },
  () => {
    let live = true;
    const { reconciler, calls } = createRecorder({
      metadata: metadata("a", { activity: "running", attention: "normal" }, {}),
      sessions: () => (live ? [session("a", { toolConfigKey: "codex", backendSessionId: "be" })] : []),
      probe: { turn: "in_progress", size: 10, mtimeMs: 1 },
      findCodexPath: () => "/codex/x.jsonl",
    });
    reconciler.scan();
    reconciler.scan();
    live = false;
    reconciler.scan();
    live = true;
    reconciler.scan();
    return { calls };
  },
);

record(
  "clears needs_response only after it stays unbacked for a second tick",
  { ticks: 2, derived: { activity: "idle", attention: "needs_response" }, pendingInteraction: false },
  () => {
    const { reconciler, calls } = createRecorder({
      metadata: metadata("a", { activity: "idle", attention: "needs_response" }),
      pendingInteraction: false,
    });
    reconciler.scan();
    reconciler.scan();
    return { calls };
  },
);

record(
  "leaves needs_response alone while an interaction is still pending",
  { ticks: 2, derived: { activity: "idle", attention: "needs_response" }, pendingInteraction: true },
  () => {
    const { reconciler, calls } = createRecorder({
      metadata: metadata("a", { activity: "idle", attention: "needs_response" }),
      pendingInteraction: true,
    });
    reconciler.scan();
    reconciler.scan();
    return { calls };
  },
);

record(
  "resets the confirm if the interaction re-registers before the second tick",
  { ticks: [false, true, false], derived: { activity: "idle", attention: "needs_response" } },
  () => {
    let pending = false;
    const { reconciler, calls } = createRecorder({
      metadata: metadata("a", { activity: "idle", attention: "needs_response" }),
      pendingInteraction: () => pending,
    });
    reconciler.scan();
    pending = true;
    reconciler.scan();
    pending = false;
    reconciler.scan();
    return { calls };
  },
);

record("re-resolves when the backendSessionId changes on a live session", { ticks: ["be-1", "be-1", "be-2"] }, () => {
  let backendSessionId = "be-1";
  const { reconciler, calls } = createRecorder({
    metadata: metadata("a", { activity: "running", attention: "normal" }, {}),
    sessions: () => [session("a", { toolConfigKey: "codex", backendSessionId })],
    probe: { turn: "in_progress", size: 10, mtimeMs: 1 },
    findCodexPath: (id) => `/codex/${id}.jsonl`,
  });
  reconciler.scan();
  reconciler.scan();
  backendSessionId = "be-2";
  reconciler.scan();
  return { calls };
});

record("does not re-scan the codex tree every tick after a miss", { ticks: 5, codexPath: null }, () => {
  const { reconciler, calls } = createRecorder({
    metadata: metadata("a", { activity: "running", attention: "normal" }, {}),
    sessions: [session("a", { toolConfigKey: "codex", backendSessionId: "be" })],
    findCodexPath: null,
  });
  for (let index = 0; index < 5; index++) reconciler.scan();
  return { calls };
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/transcript-reconciler.test.ts",
  generatedBy: "scripts/capture-transcript-reconciler-contract.mjs",
  description:
    "Transcript reconciler stuck-activity settlement, stranded needs_response clearing, and Codex transcript path cache behavior captured by running TypeScript.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
