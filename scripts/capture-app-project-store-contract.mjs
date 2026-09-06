#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import ts from "typescript";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/app-state/project-store.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

async function importPureModule() {
  const sourceText = await readFile(new URL("app/stores/project.ts", ROOT), "utf8");
  const scopeSource = sourceText.match(/const projectResourceRequestScope[\s\S]*?let projectResourceRequestSequence = 0;/)?.[0];
  const emptyObservability = sourceText.slice(
    sourceText.indexOf("export function emptyProjectObservability"),
    sourceText.indexOf("const emptyResource"),
  );
  const planKey = sourceText.match(/export function projectPlanResourceKey[\s\S]*?\n}/)?.[0];
  const currentRequest = sourceText.match(/export function isCurrentProjectResourceRequest[\s\S]*?\n}/)?.[0];
  const requestKey = sourceText.match(/export function projectResourceRequestKey[\s\S]*?\n}/)?.[0];
  const pureSource = [scopeSource, emptyObservability, planKey, currentRequest, requestKey].join("\n");
  const transpiled = ts.transpileModule(pureSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "app-project-store-contract.ts",
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);
}

const project = await importPureModule();

function normalizeScope(keys) {
  const seen = new Map();
  let next = 1;
  return keys.map((key) =>
    key.replace(/^([^\0]+\0[^\0]*\0\d+\0)([^\0]+)(\0\d+)$/, (_match, prefix, scope, suffix) => {
      if (!seen.has(scope)) seen.set(scope, `<scope:${next++}>`);
      return `${prefix}${seen.get(scope)}${suffix}`;
    }),
  );
}

const currentScope = { projectPath: "/repo", endpointKey: "127.0.0.1:43191", generation: 2 };

const inputs = [
  {
    name: "builds empty project observability defaults",
    source: "app/stores/project.ts",
    api: "emptyProjectObservability",
  },
  {
    name: "keys project plans by project and session",
    source: "app/stores/project.ts",
    api: "projectPlanResourceKey",
    cases: [
      { projectPath: "/repo", sessionId: "session-1" },
      { projectPath: "/repo/with space", sessionId: "claude-1" },
    ],
  },
  {
    name: "matches project resource request scopes exactly",
    source: "app/stores/project.test.ts",
    api: "isCurrentProjectResourceRequest",
    current: currentScope,
    cases: [
      currentScope,
      { projectPath: "/repo", endpointKey: "127.0.0.1:43190", generation: 2 },
      { projectPath: "/repo", endpointKey: "127.0.0.1:43191", generation: 1 },
      { projectPath: "/other", endpointKey: "127.0.0.1:43191", generation: 2 },
    ],
  },
  {
    name: "builds project resource request keys with implicit and explicit sequence",
    source: "app/stores/project.ts",
    api: "projectResourceRequestKey",
    cases: [
      { request: currentScope },
      { request: currentScope },
      { request: { projectPath: "/repo", endpointKey: null, generation: 0 }, sequence: 5 },
    ],
  },
];

function run(input) {
  switch (input.api) {
    case "emptyProjectObservability":
      return project.emptyProjectObservability();
    case "projectPlanResourceKey":
      return input.cases.map((item) => project.projectPlanResourceKey(item.projectPath, item.sessionId));
    case "isCurrentProjectResourceRequest":
      return input.cases.map((item) => project.isCurrentProjectResourceRequest(item, input.current));
    case "projectResourceRequestKey":
      return normalizeScope(input.cases.map((item) => project.projectResourceRequestKey(item.request, item.sequence)));
    default:
      throw new Error(`unknown api ${input.api}`);
  }
}

const cases = inputs.map((input, index) => ({
  id: `app-state-project-store-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: input.source,
  api: input.api,
  input,
  output: run(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: ["app/stores/project.test.ts", "app/stores/project.ts"],
  generatedBy: "scripts/capture-app-project-store-contract.mjs",
  description:
    "App project store empty observability model, plan key shape, request-scope matching, and request-key construction captured by running TypeScript project store helpers. Random request scope is normalized after execution.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
