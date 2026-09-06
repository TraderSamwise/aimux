#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/debug/logging.json", ROOT);
const {
  configureLogging,
  debug,
  log,
  logAlways,
  resetLoggingForTests,
  resolveLoggingRuntimeConfig,
  sanitizeLogString,
} = await import(new URL("dist/debug.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function normalizeRecord(record) {
  return { ...record, ts: "<ts>", pid: "<pid>" };
}

function readRecords(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  return text.split("\n").map((line) => normalizeRecord(JSON.parse(line)));
}

function runLogScenario(input) {
  const root = mkdtempSync(join(tmpdir(), "aimux-debug-contract-"));
  const logPath = join(root, "logs", "aimux.jsonl");
  try {
    resetLoggingForTests();
    configureLogging({ ...input.config, path: logPath });
    for (const op of input.operations) {
      if (op.kind === "debug") debug(op.message, op.category);
      else if (op.kind === "log.debug") log.debug(op.message, op.category, op.fields);
      else if (op.kind === "log.info") log.info(op.message, op.category, op.fields);
      else if (op.kind === "log.warn") log.warn(op.message, op.category, op.fields);
      else if (op.kind === "logAlways.info") logAlways.info(op.message, op.category, op.fields);
      else throw new Error(`unknown log op ${op.kind}`);
    }
    return { exists: existsSync(logPath), records: readRecords(logPath) };
  } finally {
    resetLoggingForTests();
    rmSync(root, { recursive: true, force: true });
  }
}

function run(input) {
  switch (input.api) {
    case "sanitizeLogString":
      return sanitizeLogString(input.text);
    case "resolveLoggingRuntimeConfig":
      return resolveLoggingRuntimeConfig(input.options);
    case "logScenario":
      return runLogScenario(input);
    default:
      throw new Error(`unknown api ${input.api}`);
  }
}

const secretMessage =
  'spawn args: ["AWS_SECRET_ACCESS_KEY=real-secret","PATH=/usr/bin","OPENAI_API_KEY=real-key","SENTRY_AUTH_TOKEN=\\"quoted-secret\\""]';

const inputs = [
  {
    name: "does not create records when disabled",
    api: "logScenario",
    config: { enabled: false, level: "debug", processKind: "test" },
    operations: [{ kind: "debug", message: "hidden", category: "test" }],
  },
  {
    name: "writes always records when disabled",
    api: "logScenario",
    config: { enabled: false, level: "debug", processKind: "test" },
    operations: [{ kind: "logAlways.info", message: "visible", category: "session", fields: { promptChars: 12 } }],
  },
  {
    name: "writes structured JSON when enabled",
    api: "logScenario",
    config: { enabled: true, level: "debug", processKind: "test", projectId: "project-1", projectRoot: "/repo" },
    operations: [{ kind: "debug", message: "hello", category: "test" }],
  },
  {
    name: "redacts secret-like env assignments and fields",
    api: "logScenario",
    config: { enabled: true, level: "debug", processKind: "test" },
    operations: [
      {
        kind: "log.debug",
        message: secretMessage,
        category: "session",
        fields: {
          token: "real-token",
          apiKey: "real-api-key",
          authToken: "real-auth-token",
          authorization: "real-authorization",
          nested: { password: "real-password", privateKey: "real-private-key", command: "SENTRY_AUTH_TOKEN=real-auth" },
        },
      },
    ],
  },
  {
    name: "filters by level and category",
    api: "logScenario",
    config: { enabled: true, level: "info", categories: ["daemon"], processKind: "test" },
    operations: [
      { kind: "log.debug", message: "debug hidden", category: "daemon" },
      { kind: "log.info", message: "wrong category hidden", category: "session" },
      { kind: "log.warn", message: "visible", category: "daemon" },
    ],
  },
  {
    name: "resolves logging config with env and cli precedence",
    api: "resolveLoggingRuntimeConfig",
    options: {
      config: {
        enabled: false,
        level: "info",
        categories: ["session"],
        maxBytes: 123,
        maxFiles: 2,
      },
      env: {
        AIMUX_LOG: "1",
        AIMUX_LOG_LEVEL: "debug",
        AIMUX_LOG_CATEGORIES: "daemon,tmux",
      },
      cli: {
        trace: true,
        logCategory: "http",
      },
      path: "/logs/aimux.jsonl",
      processKind: "test",
      projectId: "project-1",
      projectRoot: "/repo",
    },
  },
  {
    name: "sanitizes quoted secret assignment strings",
    api: "sanitizeLogString",
    text: secretMessage,
  },
];

const cases = inputs.map((input, index) => ({
  id: `debug-logging-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "src/debug.test.ts",
  api: input.api,
  input,
  output: run(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/debug.test.ts",
  generatedBy: "scripts/capture-debug-contract.mjs",
  description:
    "Debug logging config, gating, and redaction outputs captured by running TypeScript debug helpers, with timestamps and process ids normalized after execution.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
