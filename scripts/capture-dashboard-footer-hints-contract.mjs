#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/tui/dashboard-footer-hints.json", ROOT);
const GOLDEN_PATH = new URL("src/multiplexer/desktop-state-golden.fixture.json", ROOT);
const { buildDashboardFooterHints } = await import(new URL("dist/tui/screens/dashboard-renderers.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stateFromSnapshot(snapshot, overrides = {}) {
  const selectedSessionId = overrides.selectedSessionId ?? snapshot.sessions?.[0]?.id;
  const selectedServiceId = overrides.selectedServiceId ?? null;
  const selectedTeammates = selectedSessionId
    ? (snapshot.teammates ?? []).filter((session) => session.team?.parentSessionId === selectedSessionId)
    : [];
  return {
    sessions: snapshot.sessions ?? [],
    services: snapshot.services ?? [],
    worktreeGroups: snapshot.worktreeGroups ?? [],
    selectedSessionId,
    selectedServiceId,
    selectedTeammates,
    scribeSessions: (snapshot.sessions ?? []).filter((session) => session.scribe),
    previewSource: "output",
    hasWorktrees: (snapshot.worktreeGroups ?? []).length > 0,
    navLevel: "worktrees",
    hideOfflineAgents: false,
    operationFailures: snapshot.operationFailures ?? [],
    mainCheckout: snapshot.mainCheckoutInfo ?? { name: "Main Checkout", branch: "" },
    derivedStatusLabel(session) {
      return session?.semantic?.presentation?.statusLabel ?? session?.status ?? "";
    },
    ...overrides,
  };
}

const golden = JSON.parse(await readFile(GOLDEN_PATH, "utf8")).runtimeFull;
const cases = [];

function record(name, snapshot, overrides = {}) {
  const state = stateFromSnapshot(snapshot, overrides);
  const input = {
    snapshot,
    state: {
      selectedSessionId: state.selectedSessionId ?? null,
      selectedServiceId: state.selectedServiceId ?? null,
      navLevel: state.navLevel,
      hideOfflineAgents: state.hideOfflineAgents,
      previewSource: state.previewSource,
    },
  };
  cases.push({
    id: `dashboard-footer-hints-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/tui/screens/dashboard-renderers.ts",
    api: "buildDashboardFooterHints",
    input,
    output: buildDashboardFooterHints(state),
    inputSha256: hash(input),
  });
}

record("worktree level with worktrees", clone(golden), {
  navLevel: "worktrees",
  selectedSessionId: null,
});

record(
  "session level selected running agent with operation failure",
  {
    ...clone(golden),
    operationFailures: [{ id: "failure-1", message: "could not stop service" }],
  },
  {
    navLevel: "sessions",
    selectedSessionId: "claude-0",
  },
);

record("session level selected service", clone(golden), {
  navLevel: "sessions",
  selectedSessionId: null,
  selectedServiceId: "service-api",
});

record(
  "flat selected blocked offline agent",
  {
    ...clone(golden),
    worktreeGroups: [],
    services: [],
  },
  {
    navLevel: "sessions",
    selectedSessionId: "codex-offline",
    selectedServiceId: null,
  },
);

record(
  "empty dashboard",
  {
    ...clone(golden),
    sessions: [],
    services: [],
    worktreeGroups: [],
  },
  {
    navLevel: "sessions",
    selectedSessionId: null,
    selectedServiceId: null,
  },
);

record(
  "worktree level with live scribe preview toggle",
  {
    ...clone(golden),
    sessions: [
      ...clone(golden.sessions),
      { index: 4, id: "scribe-1", command: "codex", status: "running", active: false, scribe: true },
    ],
  },
  {
    navLevel: "worktrees",
    selectedSessionId: null,
    previewSource: "output",
  },
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-07T00:00:00.000Z",
  generatedBy: "scripts/capture-dashboard-footer-hints-contract.mjs",
  source: "src/tui/screens/dashboard-renderers.test.ts",
  sources: ["src/tui/screens/dashboard-renderers.test.ts", "src/tui/screens/dashboard-renderers.ts"],
  subject: "buildDashboardFooterHints",
  description: "Dashboard footer hint ordering and labels captured from TypeScript.",
  caseCount: cases.length,
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
