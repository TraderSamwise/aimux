#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/debug/lifecycle-log.json", ROOT);
const debug = await import(new URL("dist/debug.js", ROOT));
const paths = await import(new URL("dist/paths.js", ROOT));
const { logLifecycleAlways } = debug;
const { getDaemonLogPath } = paths;

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

function normalizeRecord(record) {
  return { ...record, ts: "<ts:1>", pid: "<pid>" };
}

function lastRecord() {
  return JSON.parse(readFileSync(getDaemonLogPath(), "utf8").trim().split("\n").at(-1));
}

function withHome(callback) {
  const previousHome = process.env.AIMUX_HOME;
  const home = mkdtempSync(join(tmpdir(), "aimux-lifecycle-log-contract-"));
  process.env.AIMUX_HOME = home;
  try {
    return callback(home);
  } finally {
    if (previousHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}

const cases = [];
function record(name, input, output) {
  cases.push({
    id: `debug-lifecycle-log-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/debug-lifecycle-log.test.ts",
    api: "logLifecycleAlways",
    input,
    output,
    inputSha256: hash(input),
  });
}

record(
  "writes even though logging is off, which ordinary log calls do not",
  { message: "control plane restart requested", category: "daemon", fields: { reason: "cli", pid: 1234 } },
  withHome(() => {
    logLifecycleAlways("control plane restart requested", "daemon", { reason: "cli", pid: 1234 });
    const record = lastRecord();
    return {
      logExists: existsSync(getDaemonLogPath()),
      record: normalizeRecord(record),
      pidMatchedProcess: record.pid === process.pid,
    };
  }),
);

record(
  "lands in the daemon log, where the restart it explains appears",
  { message: "control plane restart requested", category: "daemon", fields: {} },
  withHome(() => {
    logLifecycleAlways("control plane restart requested", "daemon", {});
    return {
      daemonLogPathContainsDaemon: getDaemonLogPath().includes("daemon"),
      logExists: existsSync(getDaemonLogPath()),
      record: normalizeRecord(lastRecord()),
    };
  }),
);

record(
  "redacts sensitive fields like every other record",
  { message: "control plane restart requested", category: "daemon", fields: { token: "secret-value" } },
  withHome(() => {
    logLifecycleAlways("control plane restart requested", "daemon", { token: "secret-value" });
    return { record: normalizeRecord(lastRecord()) };
  }),
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/debug-lifecycle-log.test.ts",
  generatedBy: "scripts/capture-debug-lifecycle-log-contract.mjs",
  description: "Control-plane lifecycle log write, daemon-log destination, pid presence, and sensitive-field redaction captured by running TypeScript.",
  normalization: {
    ts: "Timestamps are replaced with <ts:1>.",
    pid: "The process id field is replaced with <pid> after separately asserting it matched process.pid.",
  },
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
