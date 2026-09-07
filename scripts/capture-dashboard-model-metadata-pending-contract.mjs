#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/dashboard-model-metadata-pending.json", ROOT);

const { withMetadataSessionPending } = await import(new URL("dist/multiplexer/dashboard-model.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function normalizeError(error) {
  return error instanceof Error ? { name: error.name, message: error.message } : error;
}

function makePendingActions(input, calls) {
  let token = input.pendingToken;
  let current = input.initialPendingKind;
  return {
    setSessionAction(sessionId, kind, opts) {
      calls.push({ method: "dashboardPendingActions.setSessionAction", args: [sessionId, kind, clone(opts) ?? null] });
      current = kind;
      return token;
    },
    clearSessionAction(sessionId) {
      calls.push({ method: "dashboardPendingActions.clearSessionAction", args: [sessionId] });
      current = null;
    },
    clearSessionActionIfToken(sessionId, clearToken) {
      calls.push({ method: "dashboardPendingActions.clearSessionActionIfToken", args: [sessionId, clearToken] });
      const ok = input.clearTokenResult ?? true;
      if (ok) current = null;
      return ok;
    },
    getSessionAction(sessionId) {
      calls.push({ method: "dashboardPendingActions.getSessionAction", args: [sessionId] });
      return current;
    },
    snapshot() {
      return current ?? null;
    },
  };
}

async function runCase(input) {
  const realSetTimeout = globalThis.setTimeout;
  const timerCallbacks = [];
  const timers = [];
  const calls = [];
  try {
    globalThis.setTimeout = (callback, delay = 0) => {
      timers.push({ delay });
      timerCallbacks.push(callback);
      return { unref() {} };
    };
    const pending = makePendingActions(input, calls);
    const host = {
      mode: input.mode ?? "dashboard",
      dashboardInputEpoch: input.dashboardInputEpoch ?? 0,
      dashboardPendingActions: pending,
      reapplyDashboardPendingActions: () => calls.push({ method: "reapplyDashboardPendingActions", args: [] }),
      refreshDashboardModelFromService: async (...args) => {
        calls.push({ method: "refreshDashboardModelFromService", args: clone(args) });
        return input.refreshApplied ?? true;
      },
      isDashboardScreen: (screen) => {
        calls.push({ method: "isDashboardScreen", args: [screen] });
        return input.isDashboardScreen ?? true;
      },
      renderDashboard: () => calls.push({ method: "renderDashboard", args: [] }),
      debug: (...args) => calls.push({ method: "debug", args: clone(args) }),
    };
    const work = () => {
      calls.push({ method: "work", args: [] });
      if (input.workThrows) throw new Error(input.workThrows);
      return input.workResult ?? { ok: true };
    };
    const settle =
      input.settle === undefined
        ? undefined
        : async (result) => {
            calls.push({ method: "settle", args: [clone(result)] });
            if (input.settleThrows) throw new Error(input.settleThrows);
            return input.settle;
          };
    let result;
    try {
      result = {
        ok: true,
        value: await withMetadataSessionPending(
          host,
          input.sessionId,
          input.kind ?? "creating",
          work,
          clone(input.sessionSeed),
          settle,
          input.options ?? {},
        ),
      };
    } catch (error) {
      result = { ok: false, error: normalizeError(error) };
    }
    if (input.fireTimers) {
      for (const callback of [...timerCallbacks]) {
        callback();
        await new Promise((resolve) => realSetTimeout(resolve, 0));
      }
    }
    return {
      result,
      pending: pending.snapshot(),
      timers,
      calls,
    };
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

const sessionSeed = {
  index: -1,
  id: "codex-new",
  command: "codex",
  status: "waiting",
  active: false,
  pendingAction: "creating",
  optimistic: true,
};

const inputs = [
  {
    name: "runs work without pending state when session id is absent",
    kind: "creating",
    workResult: { created: true },
  },
  {
    name: "sets tokenized pending action and clears it after async settlement",
    sessionId: "codex-new",
    kind: "creating",
    pendingToken: 7,
    sessionSeed,
    settle: true,
    fireTimers: true,
    workResult: { sessionId: "codex-new" },
  },
  {
    name: "keeps superseded tokenized pending action after async settlement",
    sessionId: "codex-new",
    kind: "creating",
    pendingToken: 8,
    sessionSeed,
    settle: true,
    clearTokenResult: false,
    fireTimers: true,
  },
  {
    name: "await settle throws after clearing current token",
    sessionId: "codex-new",
    kind: "forking",
    pendingToken: 9,
    sessionSeed: { ...sessionSeed, pendingAction: "forking" },
    settle: true,
    settleThrows: "not ready",
    options: { awaitSettle: true },
  },
  {
    name: "work failure clears current token and schedules reconcile",
    sessionId: "codex-new",
    kind: "creating",
    pendingToken: 10,
    sessionSeed,
    workThrows: "launch failed",
  },
  {
    name: "non-token pending cleanup falls back to get and clear",
    sessionId: "codex-new",
    kind: "creating",
    sessionSeed,
    settle: false,
    initialPendingKind: "creating",
    fireTimers: true,
  },
];

const cases = [];
for (const [index, input] of inputs.entries()) {
  const capturedInput = clone(input);
  cases.push({
    id: `dashboard-model-metadata-pending-${String(index + 1).padStart(3, "0")}`,
    name: input.name,
    source: "src/multiplexer/dashboard-model.ts",
    api: "withMetadataSessionPending",
    input: capturedInput,
    output: await runCase(capturedInput),
    inputSha256: hash(capturedInput),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/dashboard-model.ts",
  generatedBy: "scripts/capture-dashboard-model-metadata-pending-contract.mjs",
  description:
    "Dashboard metadata pending-action wrapper behavior captured by running TypeScript with fake pending-action storage, work, settle, and reconcile callbacks.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
