#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/core-command/behavior.json", ROOT);
const { AimuxDaemon } = await import(new URL("dist/daemon.js", ROOT));
const { CORE_API_ROUTES, CORE_COMMAND_NAMES } = await import(new URL("dist/core-command-contract.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};
function normalize(value) {
  const timestamps = new Map();
  let nextTimestamp = 1;
  const visit = (entry) => {
    if (typeof entry === "number" && Number.isInteger(entry) && entry === process.pid) return "<pid>";
    if (typeof entry === "string") {
      if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d\d\dZ$/.test(entry)) {
        if (!timestamps.has(entry)) timestamps.set(entry, `<ts:${nextTimestamp++}>`);
        return timestamps.get(entry);
      }
      return entry;
    }
    if (Array.isArray(entry)) return entry.map(visit);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(Object.entries(entry).map(([key, item]) => [key, visit(item)]));
    }
    return entry;
  };
  return visit(value);
}

const cases = [];
async function record(name, input) {
  const daemon = new AimuxDaemon();
  const result = await daemon.routeRequest("POST", CORE_API_ROUTES.commands, input);
  const output = normalize(result);
  cases.push({
    id: `core-command-behavior-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/core-command-contract.test.ts",
    api: "AimuxDaemon.routeRequest",
    input,
    output,
    inputSha256: hash(input),
  });
}

await record("answers daemon-local ping commands", {
  id: "test-ping",
  command: CORE_COMMAND_NAMES.ping,
});
await record("returns the daemon status snapshot", {
  id: "test-status",
  command: CORE_COMMAND_NAMES.status,
});
await record("rejects unknown commands", {
  id: "bad",
  command: "core.missing",
});
for (const command of [
  CORE_COMMAND_NAMES.projectEnsure,
  CORE_COMMAND_NAMES.projectStop,
  CORE_COMMAND_NAMES.projectKill,
]) {
  await record(`rejects ${command} without a projectRoot`, {
    id: "bad-project",
    command,
    payload: {},
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/core-command-contract.test.ts",
  generatedBy: "scripts/capture-core-command-behavior-contract.mjs",
  description: "Core command daemon route behavior captured by running TypeScript AimuxDaemon.routeRequest. Volatile pid/timestamps are normalized.",
  normalization: {
    pid: "<pid>",
    timestamps: "<ts:n> in first-appearance order",
  },
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
