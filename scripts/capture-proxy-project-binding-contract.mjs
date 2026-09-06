#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/proxy/project-binding.json", ROOT);
const proxy = await import(new URL("dist/proxy-project-binding.js", ROOT));
const { parseProxyTarget, resolveProjectRootForServiceTarget } = proxy;
const HOST = "127.0.0.1";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};
const candidate = (path, port, serviceAlive = true, host = HOST) => ({
  path,
  serviceAlive,
  serviceEndpoint: port === null ? null : { host, port: port === "<NaN>" ? Number.NaN : port },
});
const target = (port, host = HOST) => ({ host, port: port === "<NaN>" ? Number.NaN : port });
const serializableCandidate = (path, port, serviceAlive = true, host = HOST) => ({
  path,
  serviceAlive,
  serviceEndpoint: port === null ? null : { host, port },
});

const cases = [];
function record(name, api, input, output) {
  cases.push({
    id: `proxy-project-binding-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/proxy-project-binding.test.ts",
    api,
    input,
    output,
    inputSha256: hash(input),
  });
}

for (const pathname of ["/proxy/127.0.0.1/43210/agents/output"]) {
  record("reads host and port out of a proxy path", "parseProxyTarget", { pathname }, parseProxyTarget(pathname));
}
record(
  "returns null for anything that is not a proxy path",
  "parseProxyTargetBatch",
  { pathnames: ["/health", "/agents/output", "/proxy/127.0.0.1/43210", "/proxy/127.0.0.1/abc/agents"] },
  ["/health", "/agents/output", "/proxy/127.0.0.1/43210", "/proxy/127.0.0.1/abc/agents"].map((pathname) => parseProxyTarget(pathname)),
);
record("rejects a zero port in the path", "parseProxyTarget", { pathname: "/proxy/127.0.0.1/0/agents/output" }, parseProxyTarget("/proxy/127.0.0.1/0/agents/output"));

function recordResolve(name, input, candidates, resolvedTarget) {
  record(name, "resolveProjectRootForServiceTarget", input, resolveProjectRootForServiceTarget(candidates, resolvedTarget));
}

recordResolve(
  "binds a port to its live project",
  {
    candidates: [serializableCandidate("/srv/a", 43210), serializableCandidate("/srv/b", 43211)],
    target: target(43210),
  },
  [candidate("/srv/a", 43210), candidate("/srv/b", 43211)],
  target(43210),
);
recordResolve(
  "ignores a project whose service is not alive",
  {
    candidates: [serializableCandidate("/srv/dead", 51000, false), serializableCandidate("/srv/live", 51000, true)],
    target: target(51000),
  },
  [candidate("/srv/dead", 51000, false), candidate("/srv/live", 51000, true)],
  target(51000),
);
recordResolve(
  "refuses to guess when two live projects claim the same port",
  {
    candidates: [serializableCandidate("/srv/a", 51000), serializableCandidate("/srv/b", 51000)],
    target: target(51000),
  },
  [candidate("/srv/a", 51000), candidate("/srv/b", 51000)],
  target(51000),
);
recordResolve(
  "requires the host to match the recorded endpoint",
  { candidates: [serializableCandidate("/srv/a", 43210)], targets: [target(43210, "localhost"), target(43210, "::1")] },
  [candidate("/srv/a", 43210)],
  target(43210, "localhost"),
);
cases.at(-1).output = [
  resolveProjectRootForServiceTarget([candidate("/srv/a", 43210)], target(43210, "localhost")),
  resolveProjectRootForServiceTarget([candidate("/srv/a", 43210)], target(43210, "::1")),
];
recordResolve(
  "returns null when only a dead project claims the port",
  { candidates: [serializableCandidate("/srv/dead", 51000, false)], target: target(51000) },
  [candidate("/srv/dead", 51000, false)],
  target(51000),
);
record(
  "returns null for an unknown port, a null endpoint, or a pathless project",
  "resolveProjectRootForServiceTargetBatch",
  {
    attempts: [
      { candidates: [serializableCandidate("/srv/a", 43210)], target: target(43999) },
      { candidates: [serializableCandidate("/srv/a", null)], target: target(43210) },
      { candidates: [serializableCandidate("", 43210)], target: target(43210) },
      { candidates: [], target: target(43210) },
    ],
  },
  [
    resolveProjectRootForServiceTarget([candidate("/srv/a", 43210)], target(43999)),
    resolveProjectRootForServiceTarget([candidate("/srv/a", null)], target(43210)),
    resolveProjectRootForServiceTarget([candidate("", 43210)], target(43210)),
    resolveProjectRootForServiceTarget([], target(43210)),
  ],
);
record(
  "rejects nonsense ports even when a candidate records one",
  "resolveProjectRootForServiceTargetBatch",
  {
    attempts: [
      { candidates: [serializableCandidate("/srv/a", 0)], target: target(0) },
      { candidates: [serializableCandidate("/srv/a", -1)], target: target(-1) },
      { candidates: [serializableCandidate("/srv/a", "<NaN>")], target: target("<NaN>") },
      { candidates: [serializableCandidate("/srv/a", 1.5)], target: target(1.5) },
    ],
  },
  [
    resolveProjectRootForServiceTarget([candidate("/srv/a", 0)], target(0)),
    resolveProjectRootForServiceTarget([candidate("/srv/a", -1)], target(-1)),
    resolveProjectRootForServiceTarget([candidate("/srv/a", "<NaN>")], target("<NaN>")),
    resolveProjectRootForServiceTarget([candidate("/srv/a", 1.5)], target(1.5)),
  ],
);
record(
  "returns null for a missing target or empty host",
  "resolveProjectRootForServiceTargetBatch",
  {
    attempts: [
      { candidates: [serializableCandidate("/srv/a", 43210)], target: null },
      { candidates: [serializableCandidate("/srv/a", 43210)], target: target(43210, "") },
    ],
  },
  [
    resolveProjectRootForServiceTarget([candidate("/srv/a", 43210)], null),
    resolveProjectRootForServiceTarget([candidate("/srv/a", 43210)], target(43210, "")),
  ],
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/proxy-project-binding.test.ts",
  generatedBy: "scripts/capture-proxy-project-binding-contract.mjs",
  description: "Proxy path parsing and live project service target binding/refusal contracts captured by running TypeScript.",
  normalization: {
    NaN: "NaN ports are represented as <NaN> in fixture input because JSON has no NaN literal.",
  },
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
