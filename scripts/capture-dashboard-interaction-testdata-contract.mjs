#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const SOURCE_CONTRACT_PATH = new URL("src/multiplexer/dashboard-interaction.contract.v1.json", ROOT);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/dashboard-interaction.json", ROOT);

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

const result = spawnSync(process.execPath, ["scripts/capture-dashboard-interaction-contract.mjs"], {
  cwd: ROOT,
  encoding: "utf8",
  stdio: "pipe",
});
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.stdout.write(result.stdout);
  process.exit(result.status ?? 1);
}

const generated = JSON.parse(await readFile(SOURCE_CONTRACT_PATH, "utf8"));
const cases = generated.cases.map((entry) => ({
  ...entry,
  source: "src/multiplexer/dashboard-interaction.test.ts",
}));

await writeContractJson(FIXTURE_PATH, {
  ...generated,
  generatedBy: "scripts/capture-dashboard-interaction-testdata-contract.mjs",
  source: "src/multiplexer/dashboard-interaction.test.ts",
  sources: ["src/multiplexer/dashboard-interaction.test.ts", "src/multiplexer/dashboard-interaction.ts"],
  subject: "dashboardInteractionMethods.handleDashboardKey",
  description:
    "Dashboard interaction/navigation behavior captured by running TypeScript dashboardInteractionMethods through the existing capture harness.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
