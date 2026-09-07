#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/dashboard-model-pending-actions.json", ROOT);
const { reconcileDashboardPendingActionsFromRawModel } = await import(new URL("dist/multiplexer/dashboard-model.js", ROOT));

const FIXED_NOW = 1_700_000_000_000;
Date.now = () => FIXED_NOW;

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function runCase(input) {
  const calls = [];
  const clearResults = input.clearResults ?? {};
  const pending = {
    listSessionActions() {
      calls.push({ method: "listSessionActions", args: [] });
      return clone(input.sessionActions ?? []);
    },
    clearSessionActionIfToken(id, token) {
      calls.push({ method: "clearSessionActionIfToken", args: [id, token] });
      return clearResults[`session:${id}:${token}`] ?? true;
    },
    listServiceActions() {
      calls.push({ method: "listServiceActions", args: [] });
      return clone(input.serviceActions ?? []);
    },
    clearServiceActionIfToken(id, token) {
      calls.push({ method: "clearServiceActionIfToken", args: [id, token] });
      return clearResults[`service:${id}:${token}`] ?? true;
    },
  };
  const result = reconcileDashboardPendingActionsFromRawModel(
    { dashboardPendingActions: pending },
    clone(input.rawSessions ?? []),
    clone(input.rawTeammates ?? []),
    clone(input.rawServices ?? []),
  );
  return { result, calls };
}

const oldStartedAt = new Date(FIXED_NOW - 6_000).toISOString();
const freshStartedAt = new Date(FIXED_NOW - 1_000).toISOString();

const inputs = [
  {
    name: "clears session create and fork actions when raw sessions become running",
    sessionActions: [
      { id: "codex-new", kind: "creating", token: 1, startedAt: freshStartedAt },
      { id: "claude-fork", kind: "forking", token: 2, startedAt: freshStartedAt },
    ],
    rawSessions: [
      { id: "codex-new", command: "codex", status: "running" },
      { id: "claude-fork", command: "claude", status: "running" },
    ],
  },
  {
    name: "keeps fresh starting sessions pending while clearing aged offline starts",
    sessionActions: [
      { id: "fresh-start", kind: "starting", token: 3, startedAt: freshStartedAt },
      { id: "aged-start", kind: "starting", token: 4, startedAt: oldStartedAt },
    ],
    rawSessions: [
      { id: "fresh-start", command: "claude", status: "offline" },
      { id: "aged-start", command: "claude", status: "offline" },
    ],
  },
  {
    name: "clears stop when a session is absent or no longer running",
    sessionActions: [
      { id: "gone-stop", kind: "stopping", token: 5, startedAt: freshStartedAt },
      { id: "offline-stop", kind: "stopping", token: 6, startedAt: freshStartedAt },
      { id: "still-running", kind: "stopping", token: 7, startedAt: freshStartedAt },
    ],
    rawSessions: [
      { id: "offline-stop", command: "claude", status: "offline" },
      { id: "still-running", command: "claude", status: "running" },
    ],
  },
  {
    name: "clears graveyard only after the session disappears",
    sessionActions: [
      { id: "gone-graveyard", kind: "graveyarding", token: 8, startedAt: freshStartedAt },
      { id: "visible-graveyard", kind: "graveyarding", token: 9, startedAt: freshStartedAt },
    ],
    rawTeammates: [{ id: "visible-graveyard", command: "claude", status: "offline" }],
  },
  {
    name: "clears services when raw lifecycle proves create start stop and remove settled",
    serviceActions: [
      { id: "svc-create", kind: "creating", token: 10, startedAt: freshStartedAt },
      { id: "svc-start-aged", kind: "starting", token: 11, startedAt: oldStartedAt },
      { id: "svc-stop", kind: "stopping", token: 12, startedAt: freshStartedAt },
      { id: "svc-remove", kind: "removing", token: 13, startedAt: freshStartedAt },
      { id: "svc-start-fresh", kind: "starting", token: 14, startedAt: freshStartedAt },
    ],
    rawServices: [
      { id: "svc-create", command: "yarn", args: [], status: "running" },
      { id: "svc-start-aged", command: "yarn", args: [], status: "offline" },
      { id: "svc-stop", command: "yarn", args: [], status: "offline" },
      { id: "svc-start-fresh", command: "yarn", args: [], status: "offline" },
    ],
  },
  {
    name: "returns false when matching clear token has already been superseded",
    sessionActions: [{ id: "codex-new", kind: "creating", token: 15, startedAt: freshStartedAt }],
    rawSessions: [{ id: "codex-new", command: "codex", status: "running" }],
    clearResults: { "session:codex-new:15": false },
  },
];

const cases = inputs.map((input, index) => ({
  id: `dashboard-model-pending-actions-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "src/multiplexer/dashboard-model.ts",
  api: "reconcileDashboardPendingActionsFromRawModel",
  input,
  output: runCase(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/dashboard-model.ts",
  generatedBy: "scripts/capture-dashboard-model-pending-actions-contract.mjs",
  description:
    "Dashboard pending-action reconciliation captured by running TypeScript reconcileDashboardPendingActionsFromRawModel with raw session/service snapshots.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
