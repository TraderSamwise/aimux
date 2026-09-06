#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/tui-api-runtime.json", ROOT);
const { hasTuiApiRuntimeReadTransport, isRecoverableTuiApiError, isTuiApiConnectionMutationBlocked } = await import(
  new URL("dist/multiplexer/tui-api-runtime.js", ROOT)
);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function materializeError(input) {
  if (input.errorKind === "null") return null;
  const error = new Error(input.message ?? "error");
  for (const [key, value] of Object.entries(input.error ?? {})) {
    error[key] = value;
  }
  return error;
}

function materializeHost(input) {
  if (input.host === "with-read-transport") return { getFromProjectService: () => undefined };
  if (input.host === "with-nonfunction-read-transport") return { getFromProjectService: true };
  return {};
}

function run(input) {
  switch (input.api) {
    case "isTuiApiConnectionMutationBlocked":
      return isTuiApiConnectionMutationBlocked(input.snapshot, input.options ?? {});
    case "isRecoverableTuiApiError":
      return isRecoverableTuiApiError(materializeError(input));
    case "hasTuiApiRuntimeReadTransport":
      return hasTuiApiRuntimeReadTransport(materializeHost(input));
    default:
      throw new Error(`unknown api ${input.api}`);
  }
}

const inputs = [
  {
    name: "allows mutations while ready",
    api: "isTuiApiConnectionMutationBlocked",
    snapshot: { state: "ready", failedCriticalResources: [] },
  },
  {
    name: "blocks mutations while reconnecting",
    api: "isTuiApiConnectionMutationBlocked",
    snapshot: { state: "reconnecting", failedCriticalResources: [] },
  },
  {
    name: "allows explicit recovery probes while reconnecting",
    api: "isTuiApiConnectionMutationBlocked",
    snapshot: { state: "reconnecting", failedCriticalResources: [] },
    options: { allowDuringReconnect: true },
  },
  {
    name: "blocks ready mutations when critical resources failed",
    api: "isTuiApiConnectionMutationBlocked",
    snapshot: { state: "ready", failedCriticalResources: ["desktop-state"] },
  },
  {
    name: "blocks stale repairing and failed states",
    api: "isTuiApiConnectionMutationBlocked",
    snapshots: [
      { state: "stale", failedCriticalResources: [] },
      { state: "repairing", failedCriticalResources: [] },
      { state: "failed", failedCriticalResources: [] },
    ],
  },
  {
    name: "honors explicit recoverable error override",
    api: "isRecoverableTuiApiError",
    error: { tuiApiRecoverable: true, status: 400 },
  },
  {
    name: "honors explicit nonrecoverable error override",
    api: "isRecoverableTuiApiError",
    error: { tuiApiRecoverable: false, status: 503 },
  },
  {
    name: "treats retryable HTTP statuses as recoverable",
    api: "isRecoverableTuiApiError",
    errors: [{ status: 408 }, { status: 409 }, { status: 425 }, { status: 429 }, { status: 500 }, { status: 503 }],
  },
  {
    name: "treats most 4xx statuses as semantic failures",
    api: "isRecoverableTuiApiError",
    errors: [{ status: 400 }, { status: 401 }, { status: 404 }],
  },
  {
    name: "treats transient socket codes as recoverable",
    api: "isRecoverableTuiApiError",
    errors: [{ code: "ETIMEDOUT" }, { code: "ECONNREFUSED" }, { code: "ECONNRESET" }, { code: "EPIPE" }],
  },
  {
    name: "defaults unknown errors to recoverable",
    api: "isRecoverableTuiApiError",
    errors: [{ code: "UNKNOWN" }, {}, null],
  },
  {
    name: "detects host read transport presence",
    api: "hasTuiApiRuntimeReadTransport",
    hosts: ["with-read-transport", "with-nonfunction-read-transport", "empty"],
  },
];

function expandRun(input) {
  if (input.snapshots) {
    return input.snapshots.map((snapshot) => ({ snapshot, blocked: isTuiApiConnectionMutationBlocked(snapshot, input.options ?? {}) }));
  }
  if (input.errors) {
    return input.errors.map((error) => ({ error, recoverable: isRecoverableTuiApiError(materializeError({ error })) }));
  }
  if (input.hosts) {
    return input.hosts.map((host) => ({ host, hasReadTransport: hasTuiApiRuntimeReadTransport(materializeHost({ host })) }));
  }
  return run(input);
}

const cases = inputs.map((input, index) => ({
  id: `tui-api-runtime-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "src/multiplexer/tui-api-runtime.test.ts",
  api: input.api,
  input,
  output: expandRun(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/tui-api-runtime.test.ts",
  generatedBy: "scripts/capture-tui-api-runtime-contract.mjs",
  description:
    "TUI API runtime pure connection policy contracts captured by running TypeScript mutation-blocking, recoverable-error, and read-transport helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
