#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/runtime-state/dashboard-repair-notices.json", ROOT);

const { recordDashboardRepairNotice } = await import(new URL("dist/multiplexer/repair-notices.js", ROOT));

const FIXED_NOW = 1770000000000;
Date.now = () => FIXED_NOW;

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

const input = {
  host: { mode: "session" },
  notice: {
    kind: "tui-api-recovery",
    phase: "succeeded",
    message: "Aimux API recovery complete",
  },
};
const renderCurrentDashboardView = calls();
const host = { ...input.host, renderCurrentDashboardView };
const result = recordDashboardRepairNotice(host, input.notice);

const output = {
  result,
  host: {
    dashboardRepairNotices: host.dashboardRepairNotices,
    footerFlash: host.footerFlash,
    footerFlashTicks: host.footerFlashTicks,
  },
  calls: { renderCurrentDashboardView: renderCurrentDashboardView.items },
};

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/repair-notices.test.ts",
  generatedBy: "scripts/capture-dashboard-repair-notices-contract.mjs",
  description:
    "Dashboard repair notice recording, timestamp, flash suppression, and render side effects captured by running TypeScript recordDashboardRepairNotice.",
  normalization: {
    timestamps: `Date.now() is fixed at ${FIXED_NOW} while executing the TypeScript capture.`,
  },
  cases: [
    {
      id: "runtime-state-dashboard-repair-notices-001",
      name: "records without flashing or rendering when the host is outside dashboard mode",
      source: "src/multiplexer/repair-notices.test.ts",
      sourceName: "records without flashing or rendering when the host is outside dashboard mode",
      api: "recordDashboardRepairNotice",
      input,
      output,
      inputSha256: hash(input),
    },
  ],
});

console.log(`${FIXTURE_PATH.pathname}: 1 cases`);
