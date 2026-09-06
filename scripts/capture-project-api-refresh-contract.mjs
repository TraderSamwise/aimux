#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import ts from "typescript";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const SOURCE_URL = new URL("app/lib/project-api-refresh.ts", ROOT);
const FIXTURE_PATH = new URL("testdata/contracts/v1/project-api/refresh.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

async function importTypeScriptModule(url) {
  let source = await readFile(url, "utf8");
  source = source.replace(/import \{ useCallback, useLayoutEffect, useRef \} from "react";/, "");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: url.pathname,
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);
}

const { createSerializedProjectApiRefresh } = await importTypeScriptModule(SOURCE_URL);

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

async function run(input) {
  const timeline = [];
  const deferreds = [];
  let callCount = 0;
  const callers = [];
  const refresh = () => {
    callCount += 1;
    const next = deferred();
    deferreds.push(next);
    timeline.push({ step: "refresh", callCount });
    return next.promise;
  };
  const serialized = createSerializedProjectApiRefresh(refresh);

  for (const op of input.ops) {
    if (op.op === "trigger") {
      callers.push(serialized());
      timeline.push({ step: op.label ?? "trigger", callCount, pendingRefreshes: deferreds.length });
    } else if (op.op === "resolve") {
      deferreds[op.index].resolve();
      await flushPromises();
      timeline.push({ step: op.label ?? `resolve-${op.index}`, callCount, pendingRefreshes: deferreds.length });
    } else if (op.op === "awaitAll") {
      const remaining = deferreds.slice();
      for (const item of remaining) item.resolve();
      await Promise.all(callers);
      timeline.push({ step: op.label ?? "awaitAll", callCount, pendingRefreshes: deferreds.length });
    }
  }
  return timeline;
}

const scenarios = [
  {
    name: "coalesces overlapping refresh requests into one follow-up run",
    ops: [
      { op: "trigger", label: "first-trigger" },
      { op: "trigger", label: "overlap-trigger" },
      { op: "resolve", index: 0, label: "first-resolved" },
      { op: "resolve", index: 1, label: "second-resolved" },
      { op: "awaitAll", label: "all-awaited" },
    ],
  },
  {
    name: "runs sequential non-overlapping refreshes independently",
    ops: [
      { op: "trigger", label: "first-trigger" },
      { op: "resolve", index: 0, label: "first-resolved" },
      { op: "trigger", label: "second-trigger" },
      { op: "resolve", index: 1, label: "second-resolved" },
      { op: "awaitAll", label: "all-awaited" },
    ],
  },
  {
    name: "coalesces many overlaps into one follow-up run",
    ops: [
      { op: "trigger", label: "first-trigger" },
      { op: "trigger", label: "overlap-a" },
      { op: "trigger", label: "overlap-b" },
      { op: "resolve", index: 0, label: "first-resolved" },
      { op: "resolve", index: 1, label: "second-resolved" },
      { op: "awaitAll", label: "all-awaited" },
    ],
  },
];

const cases = [];
for (const [index, scenario] of scenarios.entries()) {
  const input = { ops: scenario.ops };
  cases.push({
    id: `project-api-refresh-${String(index + 1).padStart(3, "0")}`,
    name: scenario.name,
    source: "app/lib/project-api-refresh.test.ts",
    api: "createSerializedProjectApiRefresh",
    input,
    output: await run(input),
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "app/lib/project-api-refresh.test.ts",
  generatedBy: "scripts/capture-project-api-refresh-contract.mjs",
  description:
    "App serialized project API refresh coalescing timelines captured by running TypeScript createSerializedProjectApiRefresh with deferred refresh callbacks.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
