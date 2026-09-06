#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/cli/project-service.json", ROOT);
const {
  ProjectServiceVersionError,
  coreProjectServicePid,
  findCoreProject,
  renderProjectServiceVersionHelp,
} = await import(new URL("dist/cli/project-service.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function run(input) {
  switch (input.api) {
    case "findCoreProject":
      return findCoreProject(input.projects, input.projectRoot);
    case "coreProjectServicePid":
      return coreProjectServicePid(input.project);
    case "renderProjectServiceVersionHelp":
      return renderProjectServiceVersionHelp(
        new ProjectServiceVersionError(input.message, input.projectRoot, input.expected, input.actual),
      );
    default:
      throw new Error(`unknown api ${input.api}`);
  }
}

const projects = [
  { path: "/tmp/aimux/a/../a", service: { pid: 123 } },
  { path: "/tmp/aimux/b", service: null },
];

const inputs = [
  {
    name: "matches projects by resolved path",
    api: "findCoreProject",
    projects,
    projectRoot: "/tmp/aimux/a",
  },
  {
    name: "returns null for unmatched resolved path",
    api: "findCoreProject",
    projects,
    projectRoot: "/tmp/aimux/c",
  },
  {
    name: "reads numeric project service pid",
    api: "coreProjectServicePid",
    project: { service: { pid: 123 } },
  },
  {
    name: "rejects string project service pid",
    api: "coreProjectServicePid",
    project: { service: { pid: "123" } },
  },
  {
    name: "renders stale project-service build help",
    api: "renderProjectServiceVersionHelp",
    message: "stale",
    projectRoot: "/repo",
    expected: { version: "local-a", buildStamp: "local-a" },
    actual: { version: "local-b", buildStamp: "local-b" },
  },
];

const cases = inputs.map((input, index) => ({
  id: `cli-project-service-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "src/cli/project-service.test.ts",
  api: input.api,
  input,
  output: run(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/cli/project-service.test.ts",
  generatedBy: "scripts/capture-cli-project-service-contract.mjs",
  description:
    "CLI project-service path matching, pid extraction, and version-help text captured by running TypeScript cli/project-service helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
