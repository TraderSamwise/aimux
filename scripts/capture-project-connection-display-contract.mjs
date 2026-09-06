#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import ts from "typescript";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const SOURCE_URL = new URL("app/lib/project-connection-display.ts", ROOT);
const FIXTURE_PATH = new URL("testdata/contracts/v1/project-connection/display.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

async function importTypeScriptModule(url) {
  const source = await readFile(url, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
    },
    fileName: url.pathname,
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);
}

const {
  formatProjectEndpointLabel,
  getProjectServiceEndpoint,
  isDevicePendingApprovalError,
  isProjectHostOfflineError,
  isRelayUnavailableForProjectDiscovery,
  projectStateErrorCopy,
  relayUnavailableProjectCopy,
} = await importTypeScriptModule(SOURCE_URL);

function run(input) {
  if (input.api === "formatProjectEndpointLabel") return formatProjectEndpointLabel(input.endpoint, input.connectionMode);
  if (input.api === "getProjectServiceEndpoint") return getProjectServiceEndpoint(input.project);
  if (input.api === "projectStateErrorCopy") return projectStateErrorCopy(input.error);
  if (input.api === "isRelayUnavailableForProjectDiscovery") return isRelayUnavailableForProjectDiscovery(input.status);
  if (input.api === "relayUnavailableProjectCopy") return relayUnavailableProjectCopy(input.status);
  if (input.api === "isDevicePendingApprovalError") return isDevicePendingApprovalError(input.error);
  if (input.api === "isProjectHostOfflineError") return isProjectHostOfflineError(input.error);
  throw new Error(`unknown api ${input.api}`);
}

const endpoint = { host: "127.0.0.1", port: 46975 };
const project = {
  id: "project_1",
  name: "app",
  path: "/repo",
  dashboardSessionName: "aimux-app",
  service: null,
  serviceAlive: true,
  serviceEndpoint: endpoint,
};

const inputs = [
  { name: "hides loopback endpoint labels in relay mode", api: "formatProjectEndpointLabel", endpoint, connectionMode: "relay" },
  { name: "shows direct endpoints in local mode", api: "formatProjectEndpointLabel", endpoint, connectionMode: "local" },
  { name: "shows offline endpoint labels", api: "formatProjectEndpointLabel", endpoint: null, connectionMode: "relay" },
  { name: "returns live project endpoints", api: "getProjectServiceEndpoint", project },
  { name: "ignores stale offline project endpoints", api: "getProjectServiceEndpoint", project: { ...project, serviceAlive: false } },
  { name: "turns refused metadata connections into offline host copy", api: "projectStateErrorCopy", error: "connect ECONNREFUSED 127.0.0.1:51513" },
  { name: "turns browser fetch failures into offline host copy", api: "projectStateErrorCopy", error: "Failed to fetch" },
  { name: "turns pending security approval into actionable copy", api: "projectStateErrorCopy", error: "Remote client pending security approval" },
  { name: "surfaces pending security approval codes", api: "projectStateErrorCopy", error: "Remote client pending security approval. Code abc-234." },
  { name: "turns relay disconnection into reconnect guidance", api: "projectStateErrorCopy", error: "Relay not connected" },
  { name: "falls back to generic project-state error copy", api: "projectStateErrorCopy", error: "Unexpected daemon timeout" },
  { name: "detects terminal relay discovery states", api: "isRelayUnavailableForProjectDiscovery", status: "daemon_offline" },
  { name: "does not treat connecting relay state as discovery unavailable", api: "isRelayUnavailableForProjectDiscovery", status: "connecting" },
  { name: "detects pending device approval errors", api: "isDevicePendingApprovalError", error: "Remote client pending security approval" },
  { name: "detects project host offline errors", api: "isProjectHostOfflineError", error: "Network request failed" },
  { name: "renders device pending relay unavailable copy", api: "relayUnavailableProjectCopy", status: "device_pending" },
  { name: "renders daemon offline relay unavailable copy", api: "relayUnavailableProjectCopy", status: "daemon_offline" },
  { name: "renders auth failed relay unavailable copy", api: "relayUnavailableProjectCopy", status: "auth_failed" },
  { name: "renders generic relay unavailable copy", api: "relayUnavailableProjectCopy", status: "relay_unavailable" },
];

const cases = inputs.map((input, index) => ({
  id: `project-connection-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "app/lib/project-connection-display.test.ts",
  api: input.api,
  input,
  output: run(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "app/lib/project-connection-display.test.ts",
  generatedBy: "scripts/capture-project-connection-display-contract.mjs",
  description:
    "App project connection endpoint labels, project-state error copy, relay discovery gates, and relay-unavailable copy captured by running TypeScript project-connection-display helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
