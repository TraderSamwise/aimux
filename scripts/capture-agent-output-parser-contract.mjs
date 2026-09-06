#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = new URL("../", import.meta.url);
const PARSER_FIXTURE_PATH = new URL("testdata/contracts/v1/agent-output/parser-adversarial.json", ROOT);
const PARSER_FUZZ_PATH = new URL("testdata/contracts/v1/agent-output/parser-fuzz.json", ROOT);

const parserModule = await import(new URL("dist/agent-output-parser.js", ROOT));
const fixtureModule = await import(new URL("dist/agent-output-parser-fixtures.js", ROOT));
const transcriptModule = await import(new URL("dist/agent-transcript.js", ROOT));

const { parseAgentOutput: realParseAgentOutput } = parserModule;
const { AGENT_OUTPUT_PARSER_FIXTURES } = fixtureModule;
const { messagesFromParsedAgentOutput } = transcriptModule;

const hash = (value) => createHash("sha256").update(value).digest("hex");

const normalizeOptions = (options) => {
  if (!options) return {};
  return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
};

const parserCase = ({ id, name, source, raw, options, output, notes, supplemental }) => ({
  id,
  name,
  source,
  input: {
    raw,
    options: normalizeOptions(options),
  },
  output,
  rawSha256: hash(raw),
  ...(notes ? { notes } : {}),
  ...(supplemental ? { supplemental } : {}),
});

const noOpExpect = () => {
  const fn = () => proxy;
  const proxy = new Proxy(fn, {
    apply: () => proxy,
    get: () => proxy,
  });
  return proxy;
};

const createCaptureRuntime = (sourceName) => {
  const cases = [];
  const seen = new Set();
  let currentTest = "module-scope";
  let callIndex = 0;

  const recordParse = (raw, options = {}) => {
    const normalizedRaw = String(raw ?? "");
    const normalizedOptions = normalizeOptions(options);
    const output = realParseAgentOutput(normalizedRaw, normalizedOptions);
    const key = `${sourceName}\0${currentTest}\0${normalizedRaw}\0${JSON.stringify(normalizedOptions)}`;
    if (!seen.has(key)) {
      seen.add(key);
      callIndex += 1;
      cases.push(
        parserCase({
          id: `${sourceName.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}-${String(callIndex).padStart(3, "0")}`,
          name: currentTest,
          source: sourceName,
          raw: normalizedRaw,
          options: normalizedOptions,
          output,
        }),
      );
    }
    return output;
  };

  const vitest = {
    describe: (_name, fn) => fn(),
    expect: noOpExpect,
    it: (name, fn) => {
      currentTest = String(name);
      fn();
      currentTest = "module-scope";
    },
  };

  return { cases, recordParse, vitest };
};

const instrumentTestSource = (source) =>
  source
    .replace(/import\s+\{\s*describe,\s*expect,\s*it\s*\}\s+from\s+"vitest";\n/g, "")
    .replace(/import\s+type\s+\{[^}]+\}\s+from\s+"\.\/agent-output-parser\.js";\n/g, "")
    .replace(/import\s+\{\s*parseAgentOutput\s*\}\s+from\s+"\.\/agent-output-parser\.js";\n/g, "")
    .replace(/import\s+\{\s*messagesFromParsedAgentOutput\s*\}\s+from\s+"\.\/agent-transcript\.js";\n/g, "")
    .replace(/import\s+[^;]+from\s+"vitest";\n/g, "");

const executeInstrumentedTest = async (sourceName) => {
  const testUrl = new URL(sourceName, ROOT);
  const testSource = await readFile(testUrl, "utf8");
  const runtime = createCaptureRuntime(sourceName);
  const instrumented = [
    "const { describe, expect, it } = globalThis.__agentOutputParserCaptureVitest;",
    "const parseAgentOutput = globalThis.__agentOutputParserCaptureParse;",
    "const messagesFromParsedAgentOutput = globalThis.__agentOutputParserCaptureMessages;",
    instrumentTestSource(testSource),
  ].join("\n");
  const js = ts.transpileModule(instrumented, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: sourceName,
  }).outputText;

  globalThis.__agentOutputParserCaptureVitest = runtime.vitest;
  globalThis.__agentOutputParserCaptureParse = runtime.recordParse;
  globalThis.__agentOutputParserCaptureMessages = messagesFromParsedAgentOutput;

  try {
    await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(js)}#${encodeURIComponent(sourceName)}`);
  } finally {
    delete globalThis.__agentOutputParserCaptureVitest;
    delete globalThis.__agentOutputParserCaptureParse;
    delete globalThis.__agentOutputParserCaptureMessages;
  }

  return runtime.cases;
};

const captureNamedFixtures = () =>
  AGENT_OUTPUT_PARSER_FIXTURES.map((fixture, index) => {
    const options = { tool: fixture.tool };
    const parsed = realParseAgentOutput(fixture.raw, options);
    return parserCase({
      id: `agent-output-parser-fixtures-${String(index + 1).padStart(3, "0")}`,
      name: fixture.name,
      source: "src/agent-output-parser-fixtures.ts",
      raw: fixture.raw,
      options,
      output: parsed,
      notes: {
        fixtureTool: fixture.tool,
      },
      supplemental: {
        inferred: realParseAgentOutput(fixture.raw),
        messages: messagesFromParsedAgentOutput(parsed),
      },
    });
  });

const readExistingJson = async (url) => {
  try {
    return JSON.parse(await readFile(url, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return {};
    throw error;
  }
};

const writeJson = async (url, value) => {
  await writeFile(url, `${JSON.stringify(value, null, 2)}\n`);
};

const fixtureCases = captureNamedFixtures();
const parserTestCases = await executeInstrumentedTest("src/agent-output-parser.test.ts");
const fuzzCases = await executeInstrumentedTest("src/agent-output-parser-fuzz.test.ts");

const existingParser = await readExistingJson(PARSER_FIXTURE_PATH);
const parserContract = {
  ...existingParser,
  version: 1,
  source: "src/agent-output-parser-fixtures.ts, src/agent-output-parser.test.ts",
  generatedBy: "scripts/capture-agent-output-parser-contract.mjs",
  description:
    "Agent output parser contract captured by running the TypeScript parser against fixture and test inputs.",
  cases: [...fixtureCases, ...parserTestCases],
};

const fuzzContract = {
  version: 1,
  source: "src/agent-output-parser-fuzz.test.ts",
  generatedBy: "scripts/capture-agent-output-parser-contract.mjs",
  description: "Frozen deterministic parser fuzz corpus captured by running the TypeScript parser.",
  cases: fuzzCases,
};

await writeJson(PARSER_FIXTURE_PATH, parserContract);
await writeJson(PARSER_FUZZ_PATH, fuzzContract);

console.log(
  JSON.stringify(
    {
      parserFixture: pathToFileURL(PARSER_FIXTURE_PATH.pathname).pathname,
      parserCases: parserContract.cases.length,
      fuzzFixture: pathToFileURL(PARSER_FUZZ_PATH.pathname).pathname,
      fuzzCases: fuzzContract.cases.length,
    },
    null,
    2,
  ),
);
