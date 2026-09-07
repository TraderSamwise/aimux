#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/dashboard-ops-helpers.json", ROOT);

const { clearDashboardSubscreens, runDashboardOperation, waitForSessionStartForHost } = await import(
  new URL("dist/multiplexer/dashboard-ops.js", ROOT)
);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function recorder() {
  const calls = [];
  return {
    calls,
    fn(method, impl) {
      return (...args) => {
        calls.push({ method, args: clone(args) });
        return impl?.(...args);
      };
    },
  };
}

async function withFastClock(callback) {
  const realDateNow = Date.now;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let now = 0;
  Date.now = () => {
    now += 100;
    return now;
  };
  globalThis.setTimeout = ((handler, _ms = 0, ...args) => {
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

async function runCase(input) {
  const rec = recorder();
  if (input.api === "runDashboardOperation") {
    const host = {
      dashboardFeedback: {
        runOperation: rec.fn("dashboardFeedback.runOperation", async (_title, _lines, work, _errorTitle) => {
          rec.calls.push({ method: "work", args: [] });
          if (input.workError) throw new Error(input.workError);
          return input.workResult ?? null;
        }),
      },
    };
    let result = null;
    let error = null;
    try {
      result = await runDashboardOperation(host, input.title, input.lines, async () => input.workResult ?? null, input.errorTitle);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    return { result, error, calls: rec.calls };
  }
  if (input.api === "clearDashboardSubscreens") {
    const host = { dashboardState: { resetSubscreen: rec.fn("dashboardState.resetSubscreen") } };
    clearDashboardSubscreens(host);
    return { calls: rec.calls };
  }
  if (input.api === "waitForSessionStartForHost") {
    const runtime = { id: input.sessionId, command: "codex" };
    const host = {
      sessions: input.runtimePresent ? [runtime] : [],
      getSessionLabel: rec.fn("getSessionLabel"),
      dashboardPendingActions: {
        getSessionAction: rec.fn("dashboardPendingActions.getSessionAction"),
        setSessionAction: rec.fn("dashboardPendingActions.setSessionAction"),
        clearSessionAction: rec.fn("dashboardPendingActions.clearSessionAction"),
      },
      graveyardAfterStopSessionIds: new Set(),
      isSessionRuntimeLive: rec.fn("isSessionRuntimeLive", () => input.runtimeLive),
    };
    const result = await withFastClock(() => waitForSessionStartForHost(host, input.sessionId, input.timeoutMs));
    return { result, calls: rec.calls };
  }
  throw new Error(`unknown dashboard ops helper api ${input.api}`);
}

const cases = [
  {
    name: "runDashboardOperation delegates title lines work and error title to feedback controller",
    input: {
      api: "runDashboardOperation",
      title: "Starting",
      lines: ["one", "two"],
      errorTitle: "Failed start",
      workResult: { ok: true },
    },
  },
  {
    name: "runDashboardOperation uses title as default error title",
    input: {
      api: "runDashboardOperation",
      title: "Stopping",
      lines: [],
      workResult: "done",
    },
  },
  {
    name: "clearDashboardSubscreens resets dashboard state",
    input: { api: "clearDashboardSubscreens" },
  },
  {
    name: "waitForSessionStartForHost returns true when runtime is live",
    input: { api: "waitForSessionStartForHost", sessionId: "codex-1", runtimePresent: true, runtimeLive: true, timeoutMs: 300 },
  },
  {
    name: "waitForSessionStartForHost returns false when runtime never appears",
    input: { api: "waitForSessionStartForHost", sessionId: "codex-1", runtimePresent: false, runtimeLive: false, timeoutMs: 300 },
  },
];

const outputCases = [];
for (const [index, entry] of cases.entries()) {
  const input = clone(entry.input);
  outputCases.push({
    id: `dashboard-ops-helpers-${String(index + 1).padStart(3, "0")}`,
    name: entry.name,
    source: "src/multiplexer/dashboard-ops.ts",
    api: input.api,
    input,
    output: await runCase(input),
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/dashboard-ops.ts",
  generatedBy: "scripts/capture-dashboard-ops-helpers-contract.mjs",
  description:
    "Dashboard operation wrapper, subscreen reset, and wait-for-session-start host adapter behavior captured by running TypeScript dashboard-ops helpers.",
  cases: outputCases,
});

console.log(`${FIXTURE_PATH.pathname}: ${outputCases.length} cases`);
