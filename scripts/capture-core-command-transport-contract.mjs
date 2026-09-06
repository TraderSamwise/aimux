#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import ts from "typescript";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const SOURCE_URL = new URL("src/core-command-transport.ts", ROOT);
const CONTRACT_URL = new URL("dist/core-command-contract.js", ROOT);
const FIXTURE_PATH = new URL("testdata/contracts/v1/transport/core-command.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function moduleUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

const source = (await readFile(SOURCE_URL, "utf8"))
  .replace(
    'import { requestDaemonJson } from "./daemon-client.js";\n',
    "const requestDaemonJson = (...args) => globalThis.__requestDaemonJson(...args);\n",
  )
  .replace(
    `import {
  CORE_API_ROUTES,
  type CoreCommandEnvelope,
  type CoreCommandName,
  type CoreCommandOk,
  type CoreCommandPayloadByName,
  type CoreCommandResponse,
} from "./core-command-contract.js";
`,
    `const { CORE_API_ROUTES } = await import(${JSON.stringify(CONTRACT_URL.href)});\n`,
  );
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: SOURCE_URL.pathname,
}).outputText;

const { CORE_API_ROUTES, CORE_COMMAND_NAMES } = await import(CONTRACT_URL);
const { sendCoreCommand } = await import(moduleUrl(transpiled));

const inputs = [
  {
    name: "posts command envelopes to the daemon command route",
    command: CORE_COMMAND_NAMES.ping,
    options: { timeoutMs: 1234 },
    response: ({ body }) => {
      const parsed = JSON.parse(body ?? "{}");
      return {
        ok: true,
        id: "test",
        command: parsed.command,
        issuedAt: new Date(0).toISOString(),
        result: { pong: true },
      };
    },
  },
  {
    name: "throws daemon command errors",
    command: CORE_COMMAND_NAMES.ping,
    response: () => ({ ok: false, error: "bad command" }),
  },
  {
    name: "throws mismatched command responses",
    command: CORE_COMMAND_NAMES.ping,
    response: () => ({
      ok: true,
      id: "test",
      command: CORE_COMMAND_NAMES.status,
      issuedAt: new Date(0).toISOString(),
      result: { pong: true },
    }),
  },
];

async function runCase(input) {
  const calls = [];
  globalThis.__requestDaemonJson = async (path, init) => {
    calls.push({ path, init });
    return input.response(init);
  };
  try {
    return {
      ok: true,
      value: await sendCoreCommand(input.command, input.payload, input.options ?? {}),
      calls,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      calls,
    };
  }
}

const cases = [];
for (const input of inputs) {
  const fixtureInput = {
    api: "sendCoreCommand",
    command: input.command,
    ...(input.payload === undefined ? {} : { payload: input.payload }),
    ...(input.options ? { options: input.options } : {}),
    mockResponse:
      input.name === "posts command envelopes to the daemon command route"
        ? "echo-command-success"
        : input.name === "throws daemon command errors"
          ? "daemon-error"
          : "mismatched-command",
  };
  cases.push({
    id: `core-command-transport-${String(cases.length + 1).padStart(3, "0")}`,
    name: input.name,
    source: "src/core-command-transport.test.ts",
    api: "sendCoreCommand",
    input: fixtureInput,
    output: await runCase(input),
    inputSha256: hash(fixtureInput),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/core-command-transport.test.ts",
  generatedBy: "scripts/capture-core-command-transport-contract.mjs",
  description:
    "Core command transport envelope posting, timeout forwarding, daemon error propagation, and mismatched response validation captured by running TypeScript sendCoreCommand with a mocked daemon client.",
  constants: {
    route: CORE_API_ROUTES.commands,
  },
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
