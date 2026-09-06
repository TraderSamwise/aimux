#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/dashboard/orphans.json", ROOT);
const { dashboardBuildOf, isDashboardProcessArgs, selectOrphanedDashboards, selectStaleDashboards } = await import(
  new URL("dist/dashboard-orphans.js", ROOT)
);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

const dashboard = (pid, build) => ({
  pid,
  args: `/Users/sam/.volta/bin/node /Users/sam/.aimux/native/${build}/dist/launcher-bin.js --tmux-dashboard-internal`,
});

const nativeDashboard = (pid, build) => ({
  pid,
  args: `/Users/sam/.aimux/native/${build}/bin/aimux __dashboard-internal-native`,
});

function runOrphans(input) {
  switch (input.api) {
    case "dashboardBuildOf":
      return input.args.map((args) => ({ args, build: dashboardBuildOf(args) }));
    case "isDashboardProcessArgs":
      return input.args.map((args) => ({ args, dashboard: isDashboardProcessArgs(args) }));
    case "selectStaleDashboards":
      return selectStaleDashboards(input.processes, input.currentBuild, input.currentPid);
    case "selectOrphanedDashboards":
      return selectOrphanedDashboards(
        input.processes,
        new Map(input.parents),
        input.currentPid,
        new Set(input.livePanePids ?? []),
      );
    default:
      throw new Error(`unknown dashboard-orphans api ${input.api}`);
  }
}

const current = "local-490049e4";
const cases = [
  {
    name: "reads the install directory out of argv",
    api: "dashboardBuildOf",
    args: [dashboard(1, "local-490049e4").args],
  },
  {
    name: "returns nothing when the path is not a native install",
    api: "dashboardBuildOf",
    args: ["node /usr/local/bin/aimux --tmux-dashboard-internal"],
  },
  {
    name: "matches only the internal dashboard entrypoint",
    api: "isDashboardProcessArgs",
    args: [
      dashboard(1, "local-a").args,
      nativeDashboard(1, "local-a").args,
      "node launcher-bin.js daemon run",
    ],
  },
  {
    name: "selects dashboards from builds that are no longer installed",
    api: "selectStaleDashboards",
    processes: [dashboard(1, "local-94088499"), nativeDashboard(2, "local-06ce8ffe"), dashboard(3, current)],
    currentBuild: current,
  },
  {
    name: "never selects the current build, however many are running",
    api: "selectStaleDashboards",
    processes: [dashboard(1, current), dashboard(2, current), dashboard(3, current)],
    currentBuild: current,
  },
  {
    name: "never selects a process whose build cannot be read, since unknown is not evidence",
    api: "selectStaleDashboards",
    processes: [{ pid: 9, args: "node /usr/local/bin/aimux --tmux-dashboard-internal" }],
    currentBuild: current,
  },
  {
    name: "ignores processes that are not dashboards at all",
    api: "selectStaleDashboards",
    processes: [{ pid: 5, args: "node /Users/sam/.aimux/native/local-old/dist/launcher-bin.js daemon run" }],
    currentBuild: current,
  },
  {
    name: "never selects itself",
    api: "selectStaleDashboards",
    processes: [dashboard(42, "local-old")],
    currentBuild: current,
    currentPid: 42,
  },
  {
    name: "does nothing when the current build is unknown, rather than killing everything",
    api: "selectStaleDashboards",
    processes: [dashboard(1, "local-a"), dashboard(2, "local-b")],
    currentBuild: "",
  },
  {
    name: "matches the real fleet that caused this",
    api: "selectStaleDashboards",
    processes: [
      "local-94088499",
      "local-06ce8ffe",
      "local-4175298b",
      "local-30e6a58c",
      "local-d04d3ef0",
      "local-589acac9",
      "local-c9064baa",
      "local-0613c57a",
    ].map((build, index) => dashboard(index + 1, build)).concat([dashboard(100, current), dashboard(101, current)]),
    currentBuild: current,
  },
  {
    name: "selects a dashboard whose shell was reparented to init",
    api: "selectOrphanedDashboards",
    processes: [dashboard(10, "local-a")],
    parents: [
      [1, 0],
      [10, 110],
      [110, 1],
    ],
    currentPid: 999,
  },
  {
    name: "selects a native dashboard whose shell was reparented to init",
    api: "selectOrphanedDashboards",
    processes: [nativeDashboard(10, "local-a")],
    parents: [
      [1, 0],
      [10, 110],
      [110, 1],
    ],
    currentPid: 999,
  },
  {
    name: "leaves a dashboard whose shell still descends from tmux",
    api: "selectOrphanedDashboards",
    processes: [dashboard(10, "local-a")],
    parents: [
      [10, 110],
      [110, 900],
      [900, 1],
    ],
    currentPid: 999,
  },
  {
    name: "selects a dashboard whose shell is no longer a live tmux pane",
    api: "selectOrphanedDashboards",
    processes: [dashboard(10, "local-a"), dashboard(20, "local-a")],
    parents: [
      [10, 110],
      [110, 900],
      [20, 120],
      [120, 900],
      [900, 1],
    ],
    currentPid: 999,
    livePanePids: [120],
  },
  {
    name: "leaves a dashboard whose shell is still a live tmux pane",
    api: "selectOrphanedDashboards",
    processes: [dashboard(10, "local-a")],
    parents: [
      [10, 110],
      [110, 900],
      [900, 1],
    ],
    currentPid: 999,
    livePanePids: [110],
  },
  {
    name: "leaves a dashboard whose shell descends from a live tmux pane through a wrapper",
    api: "selectOrphanedDashboards",
    processes: [dashboard(10, "local-a")],
    parents: [
      [10, 110],
      [110, 120],
      [120, 900],
      [900, 1],
    ],
    currentPid: 999,
    livePanePids: [120],
  },
  {
    name: "handles parent cycles without treating them as live panes",
    api: "selectOrphanedDashboards",
    processes: [dashboard(10, "local-a")],
    parents: [
      [10, 110],
      [110, 120],
      [120, 110],
    ],
    currentPid: 999,
    livePanePids: [900],
  },
  {
    name: "treats an unknown parent as unknown, not orphaned",
    api: "selectOrphanedDashboards",
    processes: [dashboard(10, "local-a")],
    parents: [],
    currentPid: 999,
  },
  {
    name: "selectOrphanedDashboards never selects itself",
    api: "selectOrphanedDashboards",
    processes: [dashboard(10, "local-a")],
    parents: [
      [10, 110],
      [110, 1],
    ],
    currentPid: 10,
  },
  {
    name: "selectOrphanedDashboards ignores processes that are not dashboards",
    api: "selectOrphanedDashboards",
    processes: [{ pid: 10, args: "/Users/sam/.aimux/native/local-a/dist/launcher-bin.js daemon run" }],
    parents: [
      [10, 110],
      [110, 1],
    ],
    currentPid: 999,
  },
];

const contractCases = cases.map((input, index) => ({
  id: `dashboard-orphans-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "src/dashboard-orphans.test.ts",
  input,
  output: runOrphans(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/dashboard-orphans.test.ts",
  sources: ["src/dashboard-orphans.test.ts", "src/dashboard-orphans.ts"],
  generatedBy: "scripts/capture-dashboard-orphans-contract.mjs",
  description:
    "Dashboard stale/orphan process selection captured by running the TypeScript dashboard-orphans helpers.",
  cases: contractCases,
});

console.log(`${FIXTURE_PATH.pathname}: ${contractCases.length} cases`);
