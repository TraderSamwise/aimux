#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import ts from "typescript";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/app-state/global-inbox.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

async function importPureModule() {
  const sourceText = await readFile(new URL("app/stores/globalInbox.ts", ROOT), "utf8");
  const scopeSource = sourceText.match(/const globalInboxRequestScope[\s\S]*?let globalInboxRequestSequence = 0;/)?.[0];
  const pureSource = [
    scopeSource,
    sourceText.slice(sourceText.indexOf("export function globalInboxRequestKey")),
  ].join("\n");
  const transpiled = ts.transpileModule(pureSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "app-global-inbox-contract.ts",
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);
}

const inbox = await importPureModule();

function normalizeScope(keys) {
  const seen = new Map();
  let next = 1;
  return keys.map((key) =>
    key.replace(/^([^\0]+\0[^\0]+\0)([^\0]+)(\0\d+)$/, (_match, prefix, scope, suffix) => {
      if (!seen.has(scope)) seen.set(scope, `<scope:${next++}>`);
      return `${prefix}${seen.get(scope)}${suffix}`;
    }),
  );
}

const previousRows = [
  { projectPath: "/repo/a", id: "old-a" },
  { projectPath: "/repo/b", id: "old-b" },
  { projectPath: "/repo/c", id: "old-c" },
];
const nextRows = [
  { projectPath: "/repo/a", id: "new-a" },
  { projectPath: "/repo/d", id: "new-d" },
];

const inputs = [
  {
    name: "creates unique request keys across component remounts",
    source: "app/stores/globalInbox.test.ts",
    api: "globalInboxRequestKey",
    calls: [
      ["notifications", "projects-a"],
      ["notifications", "projects-a"],
      ["threads", "projects-a"],
      ["threads", "projects-a"],
    ],
  },
  {
    name: "creates stable explicit-sequence request keys",
    source: "app/stores/globalInbox.test.ts",
    api: "globalInboxRequestKey",
    calls: [
      ["notifications", "projects-a", 1],
      ["threads", "projects-a", 1],
      ["notifications", "projects-b", 2],
    ],
  },
  {
    name: "retains failed project rows after a partial global inbox refresh",
    source: "app/stores/globalInbox.ts",
    api: "mergeGlobalRowsWithPrevious",
    previousRows,
    nextRows,
    failedProjectPaths: ["/repo/b", "/repo/c"],
  },
  {
    name: "replaces all rows when no project failed",
    source: "app/stores/globalInbox.ts",
    api: "mergeGlobalRowsWithPrevious",
    previousRows,
    nextRows,
    failedProjectPaths: [],
  },
];

function run(input) {
  switch (input.api) {
    case "globalInboxRequestKey":
      return normalizeScope(input.calls.map((call) => inbox.globalInboxRequestKey(...call)));
    case "mergeGlobalRowsWithPrevious":
      return inbox.mergeGlobalRowsWithPrevious(input.previousRows, input.nextRows, new Set(input.failedProjectPaths));
    default:
      throw new Error(`unknown api ${input.api}`);
  }
}

const cases = inputs.map((input, index) => ({
  id: `app-state-global-inbox-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: input.source,
  api: input.api,
  input,
  output: run(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: ["app/stores/globalInbox.test.ts", "app/stores/globalInbox.ts"],
  generatedBy: "scripts/capture-app-global-inbox-contract.mjs",
  description:
    "App global inbox request-key and failed-project row merge behavior captured by running TypeScript globalInbox helpers. Random request-key scope is normalized after execution.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
