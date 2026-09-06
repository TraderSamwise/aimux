#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/runtime-state/dashboard-navigation.json", ROOT);

const { showMigratePicker } = await import(new URL("dist/multiplexer/navigation.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

function calls() {
  const items = [];
  const fn = (...args) => {
    items.push(args);
  };
  fn.items = items;
  return fn;
}

const cases = [];
const input = {
  host: {
    mode: "dashboard",
    projectRoot: "/repo",
    sessions: [{ id: "codex-1" }],
    activeIndex: 0,
    dashboardWorktreeGroupsCache: [
      { name: "Main Checkout", branch: "main" },
      { name: "feature", branch: "feature", path: "/repo/.aimux/worktrees/feature" },
    ],
  },
};

const openDashboardOverlay = calls();
const redrawDashboardWithOverlay = calls();
const host = {
  ...input.host,
  openDashboardOverlay,
  redrawDashboardWithOverlay,
};
showMigratePicker(host);

const output = {
  migratePickerWorktrees: host.migratePickerWorktrees,
  migratePickerSessionId: host.migratePickerSessionId,
  calls: {
    openDashboardOverlay: openDashboardOverlay.items,
    redrawDashboardWithOverlay: redrawDashboardWithOverlay.items,
  },
};

cases.push({
  id: "runtime-state-dashboard-navigation-001",
  name: "builds dashboard migrate choices from service-backed worktree groups",
  source: "src/multiplexer/navigation.test.ts",
  sourceName: "builds dashboard migrate choices from service-backed worktree groups",
  api: "showMigratePicker",
  input,
  output,
  inputSha256: hash(input),
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/navigation.test.ts",
  generatedBy: "scripts/capture-dashboard-navigation-contract.mjs",
  description:
    "Dashboard migrate-picker worktree selection and overlay side effects captured by running TypeScript showMigratePicker.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
