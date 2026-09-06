#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import ts from "typescript";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const SOURCE_URL = new URL("app/lib/monitor-capture.ts", ROOT);
const FIXTURE_PATH = new URL("testdata/contracts/v1/monitor/capture.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

async function importTypeScriptModule(url) {
  const source = await readFile(url, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: url.pathname,
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);
}

const {
  estimateBase64DecodedBytes,
  formatMonitorSampleText,
  monitorFrameFilename,
  stripDataUrlBase64,
} = await importTypeScriptModule(SOURCE_URL);

function run(input) {
  if (input.api === "monitorFrameFilename") return monitorFrameFilename(input.capturedAt);
  if (input.api === "stripDataUrlBase64") return stripDataUrlBase64(input.value);
  if (input.api === "estimateBase64DecodedBytes") return estimateBase64DecodedBytes(input.value);
  if (input.api === "formatMonitorSampleText") return formatMonitorSampleText(input.value);
  throw new Error(`unknown api ${input.api}`);
}

const rawBase64 = "aGVsbG8=";
const inputs = [
  { name: "builds stable jpeg filenames from capture timestamps", api: "monitorFrameFilename", capturedAt: "2026-08-14T01:02:03.456Z" },
  { name: "falls back to epoch filenames for invalid timestamps", api: "monitorFrameFilename", capturedAt: "not a date" },
  { name: "strips data-url prefixes", api: "stripDataUrlBase64", value: `data:image/jpeg;base64,${rawBase64}` },
  { name: "leaves raw base64 unchanged", api: "stripDataUrlBase64", value: rawBase64 },
  { name: "estimates decoded raw base64 bytes", api: "estimateBase64DecodedBytes", value: rawBase64 },
  { name: "estimates decoded data-url bytes", api: "estimateBase64DecodedBytes", value: `data:image/jpeg;base64,${rawBase64}` },
  { name: "ignores whitespace when estimating base64", api: "estimateBase64DecodedBytes", value: "aGVs bG8=\n" },
  { name: "returns zero bytes for empty base64", api: "estimateBase64DecodedBytes", value: "" },
  {
    name: "formats monitor samples with frame transcript and sample-rate context",
    api: "formatMonitorSampleText",
    value: {
      capturedAt: "2026-08-14T01:02:03.456Z",
      captureMode: "camera-audio",
      frameAttached: true,
      transcript: "ship the notes",
      audioSampleRate: 16000,
    },
  },
  {
    name: "formats text-only monitor samples with skipped frame reason",
    api: "formatMonitorSampleText",
    value: {
      capturedAt: "2026-08-14T01:02:03.456Z",
      captureMode: "camera-audio",
      frameSkippedReason: "shared chat image delivery is not enabled yet",
      transcript: "debug the screen",
      audioSampleRate: 16000,
    },
  },
  {
    name: "omits audio context for camera-only samples",
    api: "formatMonitorSampleText",
    value: {
      capturedAt: "2026-08-14T01:02:03.456Z",
      captureMode: "camera",
      frameAttached: true,
      transcript: "  ",
      audioSampleRate: 16000,
    },
  },
];

const cases = inputs.map((input, index) => ({
  id: `monitor-capture-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "app/lib/monitor-capture.test.ts",
  api: input.api,
  input,
  output: run(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "app/lib/monitor-capture.test.ts",
  generatedBy: "scripts/capture-monitor-capture-contract.mjs",
  description:
    "App monitor capture filename, base64 stripping, decoded-size estimation, and sample text formatting behavior captured by running TypeScript monitor-capture helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
