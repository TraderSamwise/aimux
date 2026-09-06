#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/dashboard/pending-actions.json", ROOT);
const { isBlockingPendingDashboardActionKind } = await import(new URL("dist/pending-actions.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

const inputs = [
  {
    name: "recognizes every pending dashboard action as blocking",
    values: ["creating", "forking", "migrating", "switching", "starting", "stopping", "graveyarding", "renaming", "removing"],
  },
  {
    name: "does not treat missing or unknown pending actions as blocking",
    values: [undefined, null, "done", "", "paused"],
  },
];

const cases = inputs.map((input, index) => ({
  id: `dashboard-pending-actions-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "src/dashboard/pending-actions.test.ts",
  input,
  output: input.values.map((value) => ({ value, blocking: isBlockingPendingDashboardActionKind(value) })),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/dashboard/pending-actions.test.ts",
  sources: ["src/dashboard/pending-actions.test.ts", "src/pending-actions.ts"],
  generatedBy: "scripts/capture-dashboard-pending-actions-contract.mjs",
  description:
    "Dashboard pending-action blocking-kind policy captured by running the TypeScript isBlockingPendingDashboardActionKind helper.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
