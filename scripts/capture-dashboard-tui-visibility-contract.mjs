#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("src/multiplexer/dashboard-tui-visibility.contract.v1.json", ROOT);
const {
  consumeDashboardTuiVisibilityWake,
  findTmuxPaneForProcess,
  markDashboardTuiVisible,
  parseProcessParents,
  parseTmuxPaneRows,
  parseTmuxVisibility,
  readDashboardTuiVisibilityForHost,
  readTmuxTuiVisibility,
} = await import(new URL("dist/multiplexer/tui-visibility.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function mapToRows(map) {
  return [...map.entries()].map(([pid, ppid]) => [pid, ppid]);
}

function paneRow(row) {
  return row ? { ...row } : null;
}

const cases = [];

function record(api, name, input, run) {
  const fullInput = { name, ...input };
  cases.push({
    id: `dashboard-tui-visibility-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/multiplexer/tui-visibility.ts",
    api,
    input: fullInput,
    output: run(),
    inputSha256: hash(fullInput),
  });
}

record("parseTmuxVisibility", "attached active pane is visible", { raw: "1\t1\n", paneId: "%1" }, () =>
  parseTmuxVisibility("1\t1\n", "%1"),
);
record("parseTmuxVisibility", "attached inactive pane is hidden", { raw: "1\t0\n", paneId: "%1" }, () =>
  parseTmuxVisibility("1\t0\n", "%1"),
);
record("parseTmuxVisibility", "detached active pane is detached", { raw: "0\t1\n", paneId: "%1" }, () =>
  parseTmuxVisibility("0\t1\n", "%1"),
);
record("parseTmuxVisibility", "malformed tmux output fails open", { raw: "bad", paneId: "%1" }, () =>
  parseTmuxVisibility("bad", "%1"),
);
record(
  "parseTmuxPaneRows",
  "parses valid pane rows and skips bad rows",
  { raw: "%1\t123\t1\t0\nbad\n%2\t456\t0\t1\n" },
  () => parseTmuxPaneRows("%1\t123\t1\t0\nbad\n%2\t456\t0\t1\n"),
);
record("parseProcessParents", "parses process parent rows", { raw: "250 200\n200 100\nbad\n100 1\n" }, () =>
  mapToRows(parseProcessParents("250 200\n200 100\nbad\n100 1\n")),
);
record(
  "findTmuxPaneForProcess",
  "finds owning pane through parent chain",
  {
    panes: "%1\t100\t1\t0\n%2\t500\t1\t1\n",
    parents: "250 200\n200 100\n100 1\n500 1\n",
    pid: 250,
  },
  () =>
    paneRow(
      findTmuxPaneForProcess(
        parseTmuxPaneRows("%1\t100\t1\t0\n%2\t500\t1\t1\n"),
        parseProcessParents("250 200\n200 100\n100 1\n500 1\n"),
        250,
      ),
    ),
);
record("readTmuxTuiVisibility", "assumes visible outside tmux", { env: {} }, () => readTmuxTuiVisibility({ env: {} }));
record(
  "readTmuxTuiVisibility",
  "uses direct query when process tree cannot improve it",
  {
    env: { TMUX_PANE: "%current" },
    directRaw: "1\t1\n",
    panes: "%current\t100\t1\t1\n",
    parents: "300 250\n250 1\n100 1\n",
    pid: 300,
  },
  () =>
    readTmuxTuiVisibility({
      env: { TMUX_PANE: "%current" },
      pid: 300,
      query: () => "1\t1\n",
      listPanes: () => "%current\t100\t1\t1\n",
      listProcesses: () => "300 250\n250 1\n100 1\n",
    }),
);
record(
  "readTmuxTuiVisibility",
  "prefers process-tree pane over stale direct pane",
  {
    env: { TMUX_PANE: "%stale" },
    directRaw: "1\t1\n",
    panes: "%stale\t100\t1\t1\n%live\t200\t1\t0\n",
    parents: "300 250\n250 200\n200 1\n100 1\n",
    pid: 300,
  },
  () =>
    readTmuxTuiVisibility({
      env: { TMUX_PANE: "%stale" },
      pid: 300,
      query: () => "1\t1\n",
      listPanes: () => "%stale\t100\t1\t1\n%live\t200\t1\t0\n",
      listProcesses: () => "300 250\n250 200\n200 1\n100 1\n",
    }),
);
record(
  "readTmuxTuiVisibility",
  "stale dashboard outside live tmux panes is detached",
  {
    env: { TMUX_PANE: "%stale" },
    directThrows: true,
    panes: "%live\t200\t1\t1\n",
    parents: "300 250\n250 1\n200 1\n",
    pid: 300,
  },
  () =>
    readTmuxTuiVisibility({
      env: { TMUX_PANE: "%stale" },
      pid: 300,
      query: () => {
        throw new Error("pane missing");
      },
      listPanes: () => "%live\t200\t1\t1\n",
      listProcesses: () => "300 250\n250 1\n200 1\n",
    }),
);
record("readDashboardTuiVisibilityForHost", "host cache is reused within cache window", {}, () => {
  let calls = 0;
  const host = { startedInDashboard: true };
  const first = readDashboardTuiVisibilityForHost(host, {
    now: 1000,
    readVisibility: () => {
      calls += 1;
      return parseTmuxVisibility("1\t0", "%1");
    },
  });
  const second = readDashboardTuiVisibilityForHost(host, {
    now: 1100,
    readVisibility: () => {
      calls += 1;
      return parseTmuxVisibility("1\t1", "%1");
    },
  });
  return { first, second, calls, host };
});
record("readDashboardTuiVisibilityForHost", "hidden to visible transition records wake", {}, () => {
  const host = {
    startedInDashboard: true,
    dashboardTuiVisibility: parseTmuxVisibility("1\t0", "%1"),
    dashboardTuiVisibilityCheckedAt: 1000,
  };
  const snapshot = readDashboardTuiVisibilityForHost(host, {
    force: true,
    now: 2000,
    readVisibility: () => parseTmuxVisibility("1\t1", "%1"),
  });
  return {
    snapshot,
    firstWake: consumeDashboardTuiVisibilityWake(host),
    secondWake: consumeDashboardTuiVisibilityWake(host),
    host,
  };
});
record("markDashboardTuiVisible", "focus-in marks visible and records wake", {}, () => {
  const host = {
    dashboardTuiVisibility: parseTmuxVisibility("1\t0", "%1"),
    dashboardTuiVisibilityCheckedAt: 1000,
    dashboardHiddenVisibilityRecheckAt: 5000,
    dashboardHiddenVisibilitySkipTicks: 3,
  };
  markDashboardTuiVisible(host, { now: 2000, paneId: "%1" });
  return {
    host,
    firstWake: consumeDashboardTuiVisibilityWake(host),
    secondWake: consumeDashboardTuiVisibilityWake(host),
  };
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-07T00:00:00.000Z",
  generatedBy: "scripts/capture-dashboard-tui-visibility-contract.mjs",
  source: "src/multiplexer/tui-visibility.ts",
  subject: "dashboard TUI visibility",
  description:
    "Dashboard TUI visibility parsing, process fallback, cache, and wake behavior captured by running TypeScript.",
  caseCount: cases.length,
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
