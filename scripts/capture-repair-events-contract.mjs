#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/runtime-state/repair-events.json", ROOT);
const paths = await import(new URL("dist/paths.js", ROOT));
const repairEvents = await import(new URL("dist/repair-events.js", ROOT));
const { getProjectRepairLogPathFor } = paths;
const { recordRepairEvent } = repairEvents;

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};
const cases = [];
function normalize(value, home) {
  if (typeof value === "string") return value.split(home).join("<home>");
  if (Array.isArray(value)) return value.map((entry) => normalize(entry, home));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry, home)]));
  }
  return value;
}
function record(name, api, input, output) {
  cases.push({
    id: `runtime-state-repair-events-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/repair-events.test.ts",
    api,
    input,
    output,
    inputSha256: hash(input),
  });
}
function withHome(callback) {
  const previousHome = process.env.AIMUX_HOME;
  const home = mkdtempSync(join(tmpdir(), "aimux-repair-events-contract-"));
  process.env.AIMUX_HOME = home;
  try {
    return normalize(callback(home), home);
  } finally {
    if (previousHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}

const event = {
  ts: "2026-06-22T00:00:00.000Z",
  projectRoot: "/tmp/aimux-repair-project",
  action: "tmux-runtime-repair",
  reason: "runtime contract drift",
  status: "repaired",
  details: { currentDaemonPid: 123 },
};
record(
  "records repair events in the project repair log",
  "recordRepairEvent",
  { event },
  withHome(() => {
    recordRepairEvent(event);
    const path = getProjectRepairLogPathFor(event.projectRoot);
    const [line] = readFileSync(path, "utf8").trim().split("\n");
    return {
      exists: existsSync(path),
      line: JSON.parse(line),
    };
  }),
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/repair-events.test.ts",
  generatedBy: "scripts/capture-repair-events-contract.mjs",
  description: "Repair event durable log side-effect contracts captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
