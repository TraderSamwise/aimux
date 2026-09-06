#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import ts from "typescript";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const SOURCE_URL = new URL("app/lib/request-errors.ts", ROOT);
const FIXTURE_PATH = new URL("testdata/contracts/v1/request-errors/classification.json", ROOT);

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
      esModuleInterop: true,
    },
    fileName: url.pathname,
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);
}

function valueFromDescriptor(input) {
  if (input.kind === "error") {
    const error = new Error(input.message);
    if (input.name) error.name = input.name;
    if (input.code) error.code = input.code;
    return error;
  }
  if (input.kind === "string") return input.value;
  if (input.kind === "number") return input.value;
  if (input.kind === "null") return null;
  if (input.kind === "object") return input.value;
  throw new Error(`unknown descriptor kind ${input.kind}`);
}

const { getErrorMessage, isTransientRequestError } = await importTypeScriptModule(SOURCE_URL);

const inputs = [
  { name: "returns Error messages", api: "getErrorMessage", value: { kind: "error", message: "nope" } },
  { name: "stringifies strings unchanged", api: "getErrorMessage", value: { kind: "string", value: "plain" } },
  { name: "stringifies null", api: "getErrorMessage", value: { kind: "null" } },
  { name: "stringifies ordinary objects", api: "getErrorMessage", value: { kind: "object", value: { ok: true } } },
  { name: "treats relay handoff disconnects as transient", api: "isTransientRequestError", value: { kind: "error", message: "Relay not connected" } },
  { name: "treats EPIPE messages as transient", api: "isTransientRequestError", value: { kind: "error", message: "write EPIPE" } },
  { name: "treats ECONNRESET codes as transient", api: "isTransientRequestError", value: { kind: "error", message: "socket closed", code: "ECONNRESET" } },
  { name: "treats EPIPE codes as transient", api: "isTransientRequestError", value: { kind: "error", message: "socket closed", code: "EPIPE" } },
  { name: "treats AbortError names as transient", api: "isTransientRequestError", value: { kind: "error", message: "cancelled", name: "AbortError" } },
  { name: "treats browser abort messages as transient", api: "isTransientRequestError", value: { kind: "error", message: "The operation was aborted" } },
  { name: "treats failed fetch messages as transient", api: "isTransientRequestError", value: { kind: "error", message: "Failed to fetch" } },
  { name: "treats network request failures as transient", api: "isTransientRequestError", value: { kind: "error", message: "Network request failed" } },
  { name: "treats load failures as transient", api: "isTransientRequestError", value: { kind: "error", message: "Load failed" } },
  { name: "treats socket hang ups as transient", api: "isTransientRequestError", value: { kind: "error", message: "socket hang up" } },
  { name: "treats numeric request timeout messages as transient", api: "isTransientRequestError", value: { kind: "error", message: "Request timed out after 2500ms" } },
  { name: "does not hide unexpected route errors", api: "isTransientRequestError", value: { kind: "error", message: "Route is not allowed for this shared chat" } },
  { name: "does not match malformed timeout messages", api: "isTransientRequestError", value: { kind: "error", message: "Request timed out after soon" } },
  { name: "does not treat arbitrary strings as transient", api: "isTransientRequestError", value: { kind: "string", value: "plain" } },
];

const cases = inputs.map((input, index) => {
  const value = valueFromDescriptor(input.value);
  const output =
    input.api === "getErrorMessage" ? getErrorMessage(value) : isTransientRequestError(value);
  return {
    id: `request-errors-${String(index + 1).padStart(3, "0")}`,
    name: input.name,
    source: "app/lib/request-errors.test.ts",
    api: input.api,
    input: { value: input.value },
    output,
    inputSha256: hash({ api: input.api, value: input.value }),
  };
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "app/lib/request-errors.test.ts",
  generatedBy: "scripts/capture-request-errors-contract.mjs",
  description:
    "App request-error message extraction and transient disconnect classification captured by running TypeScript app/lib/request-errors helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
