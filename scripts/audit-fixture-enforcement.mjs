#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const NATIVE_DIR = join(ROOT, "native");
const TESTS_DIR = join(ROOT, "native/crates/aimux/tests");
const REPORT_PATH = join(ROOT, "testdata/contracts/v1/ENFORCEMENT_AUDIT.md");

const args = new Set(process.argv.slice(2));
const writeReport = args.has("--write-report");
const dynamic = !args.has("--static-only");
const mergeReport = args.has("--merge-report");
const suiteFilters = process.argv
  .slice(2)
  .filter((arg) => arg.startsWith("--suite="))
  .map((arg) => arg.slice("--suite=".length));
const corpusFilters = process.argv
  .slice(2)
  .filter((arg) => arg.startsWith("--corpus="))
  .map((arg) => arg.slice("--corpus=".length));

const METADATA_KEYS = new Set([
  "id",
  "name",
  "source",
  "sources",
  "sourceName",
  "generatedBy",
  "description",
  "normalization",
  "input",
  "inputSha256",
]);

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function contractTests() {
  return readdirSync(TESTS_DIR)
    .filter((entry) => entry.endsWith(".rs"))
    .sort()
    .map((entry) => join(TESTS_DIR, entry));
}

function testSourceBundle(testPath, seen = new Set()) {
  if (seen.has(testPath) || !existsSync(testPath)) return "";
  seen.add(testPath);
  const source = readFileSync(testPath, "utf8");
  const parts = [source];
  const pathModPattern = /#\s*\[\s*path\s*=\s*"([^"]+)"\s*\]\s*mod\s+\w+\s*;/g;
  let match;
  while ((match = pathModPattern.exec(source))) {
    parts.push(testSourceBundle(join(dirname(testPath), match[1]), seen));
  }
  return parts.join("\n");
}

function includedContracts(source) {
  const contracts = [];
  const pattern = /include_str!\(\s*"([^"]*testdata\/contracts\/v1\/[^"]+\.json)"\s*\)/g;
  let match;
  while ((match = pattern.exec(source))) {
    const rel = match[1].replace(/^.*testdata\/contracts\/v1\//, "testdata/contracts/v1/");
    contracts.push(join(ROOT, rel));
  }
  return [...new Set(contracts)];
}

function fixtureOwnedContractPaths() {
  const owned = new Set();
  for (const testPath of contractTests()) {
    const suite = basename(testPath, ".rs");
    if (!suite.startsWith("fixture_")) continue;
    for (const contractPath of includedContracts(testSourceBundle(testPath))) {
      owned.add(contractPath);
    }
  }
  return owned;
}

function countCases(value) {
  if (Number.isInteger(value?.caseCount)) return value.caseCount;
  if (Array.isArray(value?.cases)) return value.cases.length;
  if (Array.isArray(value?.groups)) {
    return value.groups.reduce((sum, group) => sum + (Array.isArray(group?.cases) ? group.cases.length : 0), 0);
  }
  if (Array.isArray(value?.fixtures)) return value.fixtures.length;
  if (Array.isArray(value?.scenarios)) return value.scenarios.length;
  if (Array.isArray(value?.commands)) return value.commands.length;
  if (Array.isArray(value?.routes)) return value.routes.length;
  if (Array.isArray(value?.projects)) return value.projects.length;
  return 1;
}

function firstContractItems(value) {
  if (Array.isArray(value?.cases)) return value.cases;
  if (Array.isArray(value?.groups)) return value.groups.flatMap((group) => (Array.isArray(group?.cases) ? group.cases : []));
  for (const key of ["fixtures", "scenarios", "commands", "routes", "projects"]) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  return [value];
}

function mutateLeaf(value) {
  if (typeof value === "string") return `${value}<mutated>`;
  if (typeof value === "number") return Number.isInteger(value) ? value + 1009 : value + 1009.25;
  if (typeof value === "boolean") return !value;
  if (value === null) return "<mutated>";
  if (Array.isArray(value)) {
    if (value.length === 0) {
      value.push("<mutated>");
      return value;
    }
    value[0] = mutateLeaf(value[0]);
    return value;
  }
  if (value && typeof value === "object") {
    const preferred = ["output", "expected", "result", "stdout", "stderr", "exitCode", "status", "body", "value"];
    const keys = [
      ...preferred.filter((key) => Object.hasOwn(value, key)),
      ...Object.keys(value).filter((key) => !preferred.includes(key) && !METADATA_KEYS.has(key)),
    ];
    if (keys.length === 0) {
      value.__mutated = true;
      return value;
    }
    const key = keys[0];
    value[key] = mutateLeaf(value[key]);
    return value;
  }
  return "<mutated>";
}

function mutateContract(json) {
  const contract = JSON.parse(json);
  const count = countCases(contract);
  if (count === 0) return { mutated: false, reason: "empty case list" };
  const items = firstContractItems(contract);
  const target = items.find((item) => item && typeof item === "object" && Object.hasOwn(item, "output")) ?? items[0];
  if (target === undefined) return { mutated: false, reason: "no mutable contract item" };
  if (target && typeof target === "object" && Object.hasOwn(target, "output")) {
    target.output = mutateLeaf(target.output);
  } else if (target && typeof target === "object") {
    mutateLeaf(target);
  } else {
    const index = items.indexOf(target);
    if (index < 0) return { mutated: false, reason: "no mutable contract item" };
    items[index] = mutateLeaf(target);
  }
  const mutated = `${JSON.stringify(contract, null, 2)}\n`;
  if (sha(mutated) === sha(json)) return { mutated: false, reason: "mutation did not change file" };
  return { mutated: true, json: mutated, count };
}

function runSuite(testPath) {
  const suite = basename(testPath, ".rs");
  const result = spawnSync("cargo", ["test", "-p", "aimux", "--test", suite], {
    cwd: NATIVE_DIR,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const failedAsExpected =
    result.status !== 0 && /test result: FAILED|panicked at|assertion `|parity failures|failures:/m.test(output);
  return { status: result.status, output, failedAsExpected };
}

function audit() {
  const rows = [];
  const testPaths = contractTests();
  const fixtureOwnedContracts = fixtureOwnedContractPaths();
  for (const testPath of testPaths) {
    const source = testSourceBundle(testPath);
    const suite = basename(testPath, ".rs");
    if (suiteFilters.length > 0 && !suiteFilters.includes(suite)) continue;
    const contracts = includedContracts(source).filter(
      (contractPath) => suite.startsWith("fixture_") || !fixtureOwnedContracts.has(contractPath),
    );
    if (contracts.length === 0) continue;
    const ignored = /#\s*\[\s*ignore\b/.test(source);
    const contractResults = [];
    for (const contractPath of contracts) {
      const rel = relative(ROOT, contractPath);
      if (corpusFilters.length > 0 && !corpusFilters.includes(rel)) continue;
      if (!existsSync(contractPath)) {
        contractResults.push({ rel, status: "ERROR", cases: 0, detail: "included file missing" });
        continue;
      }
      const original = readFileSync(contractPath, "utf8");
      let parsed;
      try {
        parsed = JSON.parse(original);
      } catch (error) {
        contractResults.push({ rel, status: "ERROR", cases: 0, detail: `invalid json: ${error.message}` });
        continue;
      }
      const cases = countCases(parsed);
      if (cases === 0) {
        contractResults.push({ rel, status: "VACUOUS", cases, detail: "empty case list" });
        continue;
      }
      if (!dynamic) {
        contractResults.push({
          rel,
          status: ignored ? "CHECKLIST" : "STATIC",
          cases,
          detail: ignored
            ? "suite contains ignored checklist test; dynamic mutation not run"
            : "non-empty active suite; dynamic mutation not run",
        });
        continue;
      }
      const mutation = mutateContract(original);
      if (!mutation.mutated) {
        contractResults.push({ rel, status: "VACUOUS", cases, detail: mutation.reason });
        continue;
      }
      try {
        writeFileSync(contractPath, mutation.json);
        const result = runSuite(testPath);
        if (result.failedAsExpected) {
          contractResults.push({ rel, status: "PROVEN-FAILS", cases, detail: "mutated fixture output failed owning Rust suite" });
        } else if (result.status === 0 && ignored) {
          contractResults.push({
            rel,
            status: "CHECKLIST",
            cases,
            detail: "mutated fixture still passed because owning consumer is ignored or only partially active",
          });
        } else if (result.status === 0) {
          contractResults.push({ rel, status: "VACUOUS", cases, detail: "mutated fixture output still passed" });
        } else {
          const lastLines = result.output.trim().split("\n").slice(-8).join(" / ");
          contractResults.push({ rel, status: "ERROR", cases, detail: `suite errored without assertion failure: ${lastLines}` });
        }
      } finally {
        writeFileSync(contractPath, original);
      }
    }
    if (contractResults.length === 0) continue;
    const activeResults = contractResults.filter((result) => result.status !== "CHECKLIST");
    const suiteStatus = activeResults.some((result) => result.status === "VACUOUS")
      ? "VACUOUS"
      : activeResults.some((result) => result.status === "ERROR")
        ? "ERROR"
        : activeResults.length > 0 && activeResults.every((result) => result.status === "PROVEN-FAILS")
          ? "PROVEN-FAILS"
          : contractResults.every((result) => result.status === "CHECKLIST")
            ? "CHECKLIST"
            : "STATIC";
    rows.push({ suite, status: suiteStatus, contracts: contractResults });
  }
  return rows;
}

function parseExistingReport() {
  if (!existsSync(REPORT_PATH)) return [];
  const fixtureOwnedContracts = fixtureOwnedContractPaths();
  return readFileSync(REPORT_PATH, "utf8")
    .split("\n")
    .flatMap((line) => {
      const match = line.match(/^\| `([^`]+)` \| ([A-Z-]+) \| `([^`]+)` \| ([0-9]+) \| (.*) \|$/);
      if (!match) return [];
      if (!match[1].startsWith("fixture_") && fixtureOwnedContracts.has(join(ROOT, match[3]))) {
        return [];
      }
      return [
        {
          suite: match[1],
          status: match[2],
          rel: match[3],
          cases: Number(match[4]),
          detail: match[5],
        },
      ];
    });
}

function mergeRows(existingFlat, updateRows) {
  const updates = new Map(
    updateRows.flatMap((row) =>
      row.contracts.map((contract) => [`${row.suite}\0${contract.rel}`, { suite: row.suite, ...contract }]),
    ),
  );
  const seen = new Set();
  const merged = existingFlat.map((row) => {
    const key = `${row.suite}\0${row.rel}`;
    const update = updates.get(key);
    seen.add(key);
    return update ?? row;
  });
  for (const [key, update] of updates) {
    if (!seen.has(key)) merged.push(update);
  }
  const bySuite = new Map();
  for (const row of merged) {
    if (!bySuite.has(row.suite)) bySuite.set(row.suite, []);
    bySuite.get(row.suite).push({
      rel: row.rel,
      status: row.status,
      cases: row.cases,
      detail: row.detail,
    });
  }
  return [...bySuite.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([suite, contracts]) => {
      const activeResults = contracts.filter((result) => result.status !== "CHECKLIST");
      const status = activeResults.some((result) => result.status === "VACUOUS")
        ? "VACUOUS"
        : activeResults.some((result) => result.status === "ERROR")
          ? "ERROR"
          : activeResults.length > 0 && activeResults.every((result) => result.status === "PROVEN-FAILS")
            ? "PROVEN-FAILS"
            : contracts.every((result) => result.status === "CHECKLIST")
              ? "CHECKLIST"
              : "STATIC";
      return { suite, status, contracts };
    });
}

function renderReport(rows) {
  const flattened = rows.flatMap((row) => row.contracts.map((contract) => ({ suite: row.suite, ...contract })));
  const totals = flattened.reduce(
    (acc, row) => {
      acc[row.status] = (acc[row.status] ?? 0) + 1;
      acc.cases += row.cases;
      return acc;
    },
    { cases: 0 },
  );
  const lines = [
    "# Fixture Enforcement Audit",
    "",
    "Generated by `scripts/audit-fixture-enforcement.mjs`.",
    "",
    "Statuses:",
    "",
    "- `PROVEN-FAILS`: a deliberate fixture mutation caused the owning Rust fixture suite to fail.",
    "- `VACUOUS`: the corpus was empty or a deliberate mutation still passed.",
    "- `CHECKLIST`: the owning consumer is intentionally ignored pending a Rust API.",
    "- `ERROR`: the audit could not prove enforcement because the suite errored outside a fixture assertion.",
    "- `STATIC`: non-empty active suite observed without dynamic mutation.",
    "",
    `Summary: ${rows.length} suites, ${flattened.length} suite/corpus bindings, ${totals.cases} cases.`,
    `Binding statuses: PROVEN-FAILS ${totals["PROVEN-FAILS"] ?? 0}, VACUOUS ${totals.VACUOUS ?? 0}, CHECKLIST ${totals.CHECKLIST ?? 0}, ERROR ${totals.ERROR ?? 0}, STATIC ${totals.STATIC ?? 0}.`,
    "",
    "| Suite | Status | Corpus | Cases | Detail |",
    "| --- | --- | --- | ---: | --- |",
  ];
  for (const row of rows) {
    for (const contract of row.contracts) {
      lines.push(
        `| \`${row.suite}\` | ${contract.status} | \`${contract.rel}\` | ${contract.cases} | ${contract.detail.replaceAll("|", "\\|")} |`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

let rows = audit();
if (mergeReport) {
  rows = mergeRows(parseExistingReport(), rows);
}
const report = renderReport(rows);
if (writeReport) {
  writeFileSync(REPORT_PATH, report);
  console.log(`${relative(ROOT, REPORT_PATH)} written`);
}
const flattened = rows.flatMap((row) => row.contracts.map((contract) => ({ suite: row.suite, ...contract })));
const vacuous = flattened.filter((row) => row.status === "VACUOUS");
const errors = flattened.filter((row) => row.status === "ERROR");
console.log(
  JSON.stringify(
    {
      suites: rows.length,
      bindings: flattened.length,
      vacuous: vacuous.length,
      errors: errors.length,
      checklist: flattened.filter((row) => row.status === "CHECKLIST").length,
      provenFails: flattened.filter((row) => row.status === "PROVEN-FAILS").length,
      static: flattened.filter((row) => row.status === "STATIC").length,
      vacuousRows: vacuous.map(({ suite, rel, detail }) => ({ suite, corpus: rel, detail })),
      errorRows: errors.map(({ suite, rel, detail }) => ({ suite, corpus: rel, detail })),
    },
    null,
    2,
  ),
);
