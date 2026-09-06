#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/install-cleanup/doctor.json", ROOT);
const { isInstallCleanupDryRun, renderInstallCleanupPlan, renderInstallCleanupResult } = await import(
  new URL("dist/install-doctor.js", ROOT)
);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function makePlan(overrides = {}) {
  return {
    root: "/root/native",
    currentInstall: "current",
    retentionDays: 30,
    keepRecent: 10,
    referencesComplete: true,
    remove: [{ name: "old", path: "/root/native/old", ageDays: 70.4, sizeBytes: 19000000 }],
    keep: [
      { name: "current", reason: "current-install" },
      { name: "busy", reason: "in-use" },
    ],
    reclaimableBytes: 19000000,
    ...overrides,
  };
}

function run(input) {
  switch (input.api) {
    case "isInstallCleanupDryRun":
      return isInstallCleanupDryRun(input.options);
    case "renderInstallCleanupPlan":
      return renderInstallCleanupPlan(input.plan);
    case "renderInstallCleanupResult":
      return renderInstallCleanupResult(input.result);
    default:
      throw new Error(`unknown api ${input.api}`);
  }
}

const basePlan = makePlan();
const inputs = [
  {
    name: "keeps dry-run default unless fix is exactly true",
    api: "isInstallCleanupDryRun",
    options: {},
  },
  {
    name: "leaves dry-run mode when fix is true",
    api: "isInstallCleanupDryRun",
    options: { fix: true },
  },
  {
    name: "stays dry-run for truthy non-boolean fix value",
    api: "isInstallCleanupDryRun",
    options: { fix: "yes" },
  },
  {
    name: "summarises cleanup plan",
    api: "renderInstallCleanupPlan",
    plan: basePlan,
  },
  {
    name: "renders incomplete reference scan as non-removable",
    api: "renderInstallCleanupPlan",
    plan: makePlan({ referencesComplete: false, remove: [], reclaimableBytes: 0 }),
  },
  {
    name: "reports unknown current install",
    api: "renderInstallCleanupPlan",
    plan: makePlan({ currentInstall: null }),
  },
  {
    name: "renders dry-run cleanup result with fix guidance",
    api: "renderInstallCleanupResult",
    result: { dryRun: true, plan: basePlan, results: [], reclaimedBytes: 0 },
  },
  {
    name: "renders real cleanup result with failures",
    api: "renderInstallCleanupResult",
    result: {
      dryRun: false,
      plan: basePlan,
      results: [
        { name: "old", status: "removed", sizeBytes: 19000000 },
        { name: "stuck", status: "failed", sizeBytes: 0, error: "permission denied" },
      ],
      reclaimedBytes: 19000000,
    },
  },
  {
    name: "does not offer fix when nothing is removable",
    api: "renderInstallCleanupResult",
    result: {
      dryRun: true,
      plan: makePlan({ remove: [], reclaimableBytes: 0 }),
      results: [],
      reclaimedBytes: 0,
    },
  },
];

const cases = inputs.map((input, index) => ({
  id: `install-doctor-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "src/install-doctor.test.ts",
  api: input.api,
  input,
  output: run(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/install-doctor.test.ts",
  generatedBy: "scripts/capture-install-doctor-contract.mjs",
  description:
    "Install doctor dry-run guard and cleanup report renderer outputs captured by running TypeScript install-doctor helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
