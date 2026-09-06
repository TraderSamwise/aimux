#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/dashboard/session-actions.json", ROOT);
const { graveyardSessionWithFeedback, resumeOfflineSessionWithFeedback, stopSessionToOfflineWithFeedback } =
  await import(new URL("dist/dashboard/session-actions.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

class FakeRuntime {
  exited = false;
  exitHandlers = [];

  constructor(id, command) {
    this.id = id;
    this.command = command;
  }

  onExit(handler) {
    this.exitHandlers.push(handler);
  }

  triggerExit() {
    this.exited = true;
    for (const handler of this.exitHandlers) handler();
  }
}

async function withFastClock(callback) {
  const realDateNow = Date.now;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let now = 0;
  Date.now = () => {
    now += 1000;
    return now;
  };
  globalThis.setTimeout = ((handler, ...args) => {
    queueMicrotask(() => handler(...args));
    return 0;
  });
  globalThis.clearTimeout = (() => {});
  try {
    return await callback();
  } finally {
    Date.now = realDateNow;
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
}

function makeDeps(input, calls, runtime) {
  return {
    getSessionLabel: (sessionId) => input.labels?.[sessionId],
    getPendingAction: (sessionId) => input.pendingActions?.[sessionId],
    setPendingAction: (sessionId, kind) => calls.push(["setPendingAction", sessionId, kind]),
    stopSessionToOffline: async (session) => {
      calls.push(["stopSessionToOffline", session.id]);
      if (input.stopRejects) throw new Error(input.stopRejects);
      if (input.stopTriggersExit && runtime) runtime.triggerExit();
    },
    isGraveyardAfterStop: (sessionId) => Boolean(input.graveyardAfterStop?.[sessionId]),
    sendAgentToGraveyard: async (sessionId) => {
      calls.push(["sendAgentToGraveyard", sessionId]);
      if (input.graveyardRejects) throw new Error(input.graveyardRejects);
    },
    resumeOfflineSession: async (session) => {
      calls.push(["resumeOfflineSession", session]);
      if (input.resumeRejects) throw new Error(input.resumeRejects);
    },
    refreshLocalDashboardModel: () => calls.push(["refreshLocalDashboardModel"]),
    adjustAfterRemove: (hasWorktrees) => calls.push(["adjustAfterRemove", hasWorktrees]),
    renderDashboard: () => calls.push(["renderDashboard"]),
    showDashboardError: (title, lines) => calls.push(["showDashboardError", title, lines]),
    setFooterFlash: (message, ticks) => calls.push(["setFooterFlash", message, ticks]),
    getRuntimeById: (sessionId) => {
      calls.push(["getRuntimeById", sessionId]);
      return input.startedRuntime ? { id: sessionId, command: input.session?.command ?? "codex" } : undefined;
    },
    isSessionRuntimeLive: (session) => {
      calls.push(["isSessionRuntimeLive", session.id]);
      return Boolean(input.runtimeLive);
    },
  };
}

async function runAction(input) {
  const calls = [];
  const runtime = input.runtime ? new FakeRuntime(input.runtime.id, input.runtime.command) : undefined;
  const deps = makeDeps(input, calls, runtime);
  let result = null;
  const invoke = async () => {
    if (input.api === "resumeOfflineSessionWithFeedback") {
      result = await resumeOfflineSessionWithFeedback(deps, input.session);
    } else if (input.api === "stopSessionToOfflineWithFeedback") {
      result = (await stopSessionToOfflineWithFeedback(deps, runtime)) ?? null;
    } else if (input.api === "graveyardSessionWithFeedback") {
      result =
        (await graveyardSessionWithFeedback(deps, input.session, input.sessionId, Boolean(input.hasWorktrees))) ?? null;
    } else {
      throw new Error(`unknown session-actions api ${input.api}`);
    }
  };
  if (input.fastClock) {
    await withFastClock(invoke);
  } else {
    await invoke();
  }
  return {
    result,
    runtime: runtime ? { id: runtime.id, command: runtime.command, exited: runtime.exited } : null,
    calls,
  };
}

const cases = [
  {
    name: "no-ops duplicate resume while already starting",
    api: "resumeOfflineSessionWithFeedback",
    session: { id: "sess-1", command: "codex", label: "main" },
    labels: { "sess-1": "main" },
    pendingActions: { "sess-1": "starting" },
  },
  {
    name: "stops a session to offline and clears pending after exit",
    api: "stopSessionToOfflineWithFeedback",
    runtime: { id: "sess-1", command: "codex" },
    labels: { "sess-1": "main" },
    stopTriggersExit: true,
  },
  {
    name: "graveyards a session, clears pending, and adjusts selection",
    api: "graveyardSessionWithFeedback",
    session: { id: "sess-1", command: "codex", label: "main" },
    sessionId: "sess-1",
    hasWorktrees: true,
    labels: { "sess-1": "main" },
  },
  {
    name: "treats offline services like resumable offline entries",
    api: "resumeOfflineSessionWithFeedback",
    session: { id: "svc-1", command: "shell", label: "shell" },
    labels: { "svc-1": "shell" },
    startedRuntime: true,
    runtimeLive: true,
  },
  {
    name: "refreshes local state and clears starting when resume fails",
    api: "resumeOfflineSessionWithFeedback",
    session: { id: "sess-1", command: "codex", label: "main" },
    labels: { "sess-1": "main" },
    resumeRejects: "boom",
  },
  {
    name: "returns failed when resume completes but no live runtime appears",
    api: "resumeOfflineSessionWithFeedback",
    session: { id: "sess-1", command: "codex", label: "main" },
    labels: { "sess-1": "main" },
    startedRuntime: false,
    runtimeLive: false,
    fastClock: true,
  },
];

const contractCases = [];
for (const [index, input] of cases.entries()) {
  contractCases.push({
    id: `dashboard-session-actions-${String(index + 1).padStart(3, "0")}`,
    name: input.name,
    source: "src/dashboard/session-actions.test.ts",
    input,
    output: await runAction(input),
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/dashboard/session-actions.test.ts",
  sources: ["src/dashboard/session-actions.test.ts", "src/dashboard/session-actions.ts"],
  generatedBy: "scripts/capture-dashboard-session-actions-contract.mjs",
  description:
    "Dashboard session action results and side-effect call ordering captured by running TypeScript session-action helpers with a deterministic clock for timeout paths.",
  cases: contractCases,
});

console.log(`${FIXTURE_PATH.pathname}: ${contractCases.length} cases`);
