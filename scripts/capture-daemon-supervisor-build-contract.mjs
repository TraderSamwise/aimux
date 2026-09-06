#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/daemon-supervisor/build-generation.json", ROOT);
const {
  StaleClientBuildError,
  buildStampGeneration,
  isStaleAgainstDaemon,
  shouldKeepUnresponsiveDaemon,
} = await import(new URL("dist/daemon-supervisor.js", ROOT));

const OLDER = "1786180016000.1786180016000-35f055a7caff";
const NEWER = "1786237306000.1786237306000-35f055a7caff";
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

const cases = [];
function record(name, api, input, output) {
  cases.push({
    id: `daemon-supervisor-build-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/daemon-supervisor-build-generation.test.ts",
    api,
    input,
    output,
    inputSha256: hash(input),
  });
}

const generationInputs = [OLDER, NEWER, undefined, null, "", "-onlyhash", "nan.nan-abc", 0, "0.0-abc"];
record(
  "reads ordered build stamp generations and rejects unorderable stamps",
  "buildStampGenerationBatch",
  { stamps: generationInputs },
  generationInputs.map((stamp) => ({ stamp, generation: buildStampGeneration(stamp) })),
);
const staleInputs = [
  [NEWER, OLDER],
  [OLDER, NEWER],
  [NEWER, NEWER],
  [undefined, OLDER],
  [NEWER, undefined],
  ["garbage", "garbage"],
];
record(
  "detects staleness only when daemon generation is strictly newer",
  "isStaleAgainstDaemonBatch",
  { items: staleInputs.map(([daemonStamp, ownStamp]) => ({ daemonStamp, ownStamp })) },
  staleInputs.map(([daemonStamp, ownStamp]) => ({ daemonStamp, ownStamp, stale: isStaleAgainstDaemon(daemonStamp, ownStamp) })),
);
const staleError = new StaleClientBuildError(NEWER, OLDER);
record("names stale client build errors and points at reloading the client", "StaleClientBuildError", {
  daemonBuildStamp: NEWER,
  clientBuildStamp: OLDER,
}, {
  name: staleError.name,
  daemonBuildStamp: staleError.daemonBuildStamp,
  clientBuildStamp: staleError.clientBuildStamp,
  message: staleError.message,
});
const keepInputs = [
  [{}, true],
  [{ adoptExisting: true }, true],
  [{}, false],
  [{ adoptExisting: false }, true],
];
record(
  "keeps only alive adopted unresponsive daemons",
  "shouldKeepUnresponsiveDaemonBatch",
  { items: keepInputs.map(([options, daemonPidAlive]) => ({ options, daemonPidAlive })) },
  keepInputs.map(([options, daemonPidAlive]) => ({
    options,
    daemonPidAlive,
    keep: shouldKeepUnresponsiveDaemon(options, daemonPidAlive),
  })),
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/daemon-supervisor-build-generation.test.ts",
  generatedBy: "scripts/capture-daemon-supervisor-build-contract.mjs",
  description: "Daemon supervisor build-stamp ordering, stale-client error, and unresponsive daemon restart-loop behavior captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
