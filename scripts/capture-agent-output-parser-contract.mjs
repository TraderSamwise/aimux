#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, rmSync as realRmSync, writeFileSync as realWriteFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join as pathJoin } from "node:path";
import { pathToFileURL } from "node:url";
import prettier from "prettier";
import ts from "typescript";

const ROOT = new URL("../", import.meta.url);
const PARSER_FIXTURE_PATH = new URL("testdata/contracts/v1/agent-output/parser-adversarial.json", ROOT);
const PARSER_FUZZ_PATH = new URL("testdata/contracts/v1/agent-output/parser-fuzz.json", ROOT);
const PARSER_AUDIT_PATH = new URL("testdata/contracts/v1/agent-output/parser-audit.json", ROOT);
const PARSER_AUDIT_CORPUS_DIR = "testdata/contracts/v1/agent-output/parser-audit-corpus";
const PARSER_ACTIVITY_PATH = new URL("testdata/contracts/v1/agent-output/parser-activity-text.json", ROOT);

const parserModule = await import(new URL("dist/agent-output-parser.js", ROOT));
const auditModule = await import(new URL("dist/agent-output-parser-audit.js", ROOT));
const contractModule = await import(new URL("dist/agent-output-parser-contract.js", ROOT));
const fixtureModule = await import(new URL("dist/agent-output-parser-fixtures.js", ROOT));
const harnessModule = await import(new URL("dist/agent-output-parser-harness.js", ROOT));
const transcriptModule = await import(new URL("dist/agent-transcript.js", ROOT));

const { parseAgentOutput: realParseAgentOutput } = parserModule;
const { activityTextFromParsedAgentOutput: realActivityTextFromParsedAgentOutput } = parserModule;
const { PARSER_AUDIT_FINDING_FLAGS, auditAgentOutputParserCorpus: realAuditAgentOutputParserCorpus } = auditModule;
const { AGENT_OUTPUT_PARSER_CONTRACT } = contractModule;
const { AGENT_OUTPUT_PARSER_FIXTURES } = fixtureModule;
const { createAgentOutputParserHarness: realCreateAgentOutputParserHarness } = harnessModule;
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
  const activityCases = [];
  const auditCases = [];
  const seen = new Set();
  const parsedInputs = new WeakMap();
  const afterEachCallbacks = [];
  const pending = [];
  let currentTest = "module-scope";
  let callIndex = 0;
  let auditCallIndex = 0;
  let tempDirIndex = 0;

  const recordParse = (raw, options = {}) => {
    const normalizedRaw = String(raw ?? "");
    const normalizedOptions = normalizeOptions(options);
    const output = realParseAgentOutput(normalizedRaw, normalizedOptions);
    parsedInputs.set(output, {
      raw: normalizedRaw,
      options: normalizedOptions,
    });
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

  const activityTextFromParsedAgentOutput = (parsed) => {
    const output = realActivityTextFromParsedAgentOutput(parsed);
    const input = parsedInputs.get(parsed) ?? { parsed };
    activityCases.push({
      id: `${sourceName.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}-activity-${String(activityCases.length + 1).padStart(3, "0")}`,
      name: currentTest,
      source: sourceName,
      api: "activityTextFromParsedAgentOutput",
      input,
      output,
      inputSha256: hash(JSON.stringify(input)),
    });
    return output;
  };

  const recordHarnessRead = (read, outputById, toolById) => {
    const normalizedRaw = String(outputById.get(read.sessionId) ?? read.output ?? "");
    const normalizedOptions = normalizeOptions({ tool: toolById.get(read.sessionId) });
    const key = `${sourceName}\0${currentTest}\0harness\0${read.sessionId}\0${normalizedRaw}\0${JSON.stringify(normalizedOptions)}`;
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
          output: read.parsed,
          supplemental: {
            harnessRead: read,
          },
        }),
      );
    }
  };

  const createAgentOutputParserHarness = (sessions, options = {}) => {
    const outputById = new Map(sessions.map((session) => [session.id, session.output]));
    const toolById = new Map(sessions.map((session) => [session.id, session.tool]));
    const harness = realCreateAgentOutputParserHarness(sessions, options);
    return {
      async read(sessionId, startLine) {
        const read = await harness.read(sessionId, startLine);
        recordHarnessRead(read, outputById, toolById);
        return read;
      },
      async readAll(startLine) {
        const reads = await harness.readAll(startLine);
        for (const read of reads) recordHarnessRead(read, outputById, toolById);
        return reads;
      },
      setOutput(sessionId, output) {
        outputById.set(sessionId, output);
        return harness.setOutput(sessionId, output);
      },
    };
  };

  const auditAgentOutputParserCorpus = (options) => {
    const output = realAuditAgentOutputParserCorpus(options);
    auditCallIndex += 1;
    auditCases.push({
      id: `${sourceName.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}-audit-${String(auditCallIndex).padStart(3, "0")}`,
      name: currentTest,
      source: sourceName,
      api: "auditAgentOutputParserCorpus",
      input: options,
      output,
      inputSha256: hash(JSON.stringify(options)),
    });
    return output;
  };

  const mkdtempSync = (prefix) => {
    tempDirIndex += 1;
    const normalizedPrefix = String(prefix).replace(/[-/\\]+$/, "");
    const dir = `${normalizedPrefix}-${String(tempDirIndex).padStart(3, "0")}`;
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  const writeFileSync = (file, data) => {
    mkdirSync(dirname(file), { recursive: true });
    realWriteFileSync(file, data);
  };

  const vitest = {
    describe: (_name, fn) => fn(),
    expect: noOpExpect(),
    afterEach: (fn) => afterEachCallbacks.push(fn),
    it: (name, fn) => {
      const run = async () => {
        currentTest = String(name);
        try {
          await fn();
        } finally {
          for (const callback of afterEachCallbacks) await callback();
          currentTest = "module-scope";
        }
      };
      pending.push(run());
    },
  };

  return {
    auditCases,
    cases,
    createAgentOutputParserHarness,
    fs: {
      join: pathJoin,
      mkdtempSync,
      rmSync: () => undefined,
      tmpdir: () => PARSER_AUDIT_CORPUS_DIR,
      writeFileSync,
    },
    pending,
    recordParse,
    vitest,
    auditAgentOutputParserCorpus,
    activityCases,
    activityTextFromParsedAgentOutput,
  };
};

const instrumentTestSource = (source) =>
  source
    .replace(/import\s+\{\s*describe,\s*expect,\s*it\s*\}\s+from\s+"vitest";\n/g, "")
    .replace(/import\s+\{\s*afterEach,\s*describe,\s*expect,\s*it\s*\}\s+from\s+"vitest";\n/g, "")
    .replace(/import\s+\{\s*mkdtempSync,\s*rmSync,\s*writeFileSync\s*\}\s+from\s+"node:fs";\n/g, "")
    .replace(/import\s+\{\s*tmpdir\s*\}\s+from\s+"node:os";\n/g, "")
    .replace(/import\s+\{\s*join\s*\}\s+from\s+"node:path";\n/g, "")
    .replace(/import\s+type\s+\{[^}]+\}\s+from\s+"\.\/agent-output-parser\.js";\n/g, "")
    .replace(/import\s+\{\s*parseAgentOutput\s*\}\s+from\s+"\.\/agent-output-parser\.js";\n/g, "")
    .replace(
      /import\s+\{\s*activityTextFromParsedAgentOutput,\s*parseAgentOutput\s*\}\s+from\s+"\.\/agent-output-parser\.js";\n/g,
      "",
    )
    .replace(/import\s+\{\s*AGENT_OUTPUT_PARSER_CONTRACT\s*\}\s+from\s+"\.\/agent-output-parser-contract\.js";\n/g, "")
    .replace(/import\s+\{\s*AGENT_OUTPUT_PARSER_FIXTURES\s*\}\s+from\s+"\.\/agent-output-parser-fixtures\.js";\n/g, "")
    .replace(/import\s+\{\s*messagesFromParsedAgentOutput\s*\}\s+from\s+"\.\/agent-transcript\.js";\n/g, "")
    .replace(/import\s+\{\s*createAgentOutputParserHarness\s*\}\s+from\s+"\.\/agent-output-parser-harness\.js";\n/g, "")
    .replace(/import\s+\{\s*getParserFixture\s*\}\s+from\s+"\.\/agent-output-parser-test-utils\.js";\n/g, "")
    .replace(
      /import\s+\{\s*PARSER_AUDIT_FINDING_FLAGS,\s*auditAgentOutputParserCorpus\s*\}\s+from\s+"\.\/agent-output-parser-audit\.js";\n/g,
      "",
    )
    .replace(/import\s+[^;]+from\s+"vitest";\n/g, "");

const executeInstrumentedTest = async (sourceName) => {
  const testUrl = new URL(sourceName, ROOT);
  const testSource = await readFile(testUrl, "utf8");
  const runtime = createCaptureRuntime(sourceName);
  const instrumented = [
    "const { describe, expect, it } = globalThis.__agentOutputParserCaptureVitest;",
    "const afterEach = globalThis.__agentOutputParserCaptureVitest.afterEach;",
    "const mkdtempSync = globalThis.__agentOutputParserCaptureFs.mkdtempSync;",
    "const rmSync = globalThis.__agentOutputParserCaptureFs.rmSync;",
    "const writeFileSync = globalThis.__agentOutputParserCaptureFs.writeFileSync;",
    "const tmpdir = globalThis.__agentOutputParserCaptureFs.tmpdir;",
    "const join = globalThis.__agentOutputParserCaptureFs.join;",
    "const parseAgentOutput = globalThis.__agentOutputParserCaptureParse;",
    "const messagesFromParsedAgentOutput = globalThis.__agentOutputParserCaptureMessages;",
    "const createAgentOutputParserHarness = globalThis.__agentOutputParserCaptureHarness;",
    "const getParserFixture = globalThis.__agentOutputParserCaptureGetFixture;",
    "const auditAgentOutputParserCorpus = globalThis.__agentOutputParserCaptureAudit;",
    "const PARSER_AUDIT_FINDING_FLAGS = globalThis.__agentOutputParserCaptureAuditFlags;",
    "const activityTextFromParsedAgentOutput = globalThis.__agentOutputParserCaptureActivityText;",
    "const AGENT_OUTPUT_PARSER_CONTRACT = globalThis.__agentOutputParserCaptureContract;",
    "const AGENT_OUTPUT_PARSER_FIXTURES = globalThis.__agentOutputParserCaptureFixtures;",
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
  globalThis.__agentOutputParserCaptureFs = runtime.fs;
  globalThis.__agentOutputParserCaptureParse = runtime.recordParse;
  globalThis.__agentOutputParserCaptureMessages = messagesFromParsedAgentOutput;
  globalThis.__agentOutputParserCaptureHarness = runtime.createAgentOutputParserHarness;
  globalThis.__agentOutputParserCaptureGetFixture = (name) => {
    const fixture = AGENT_OUTPUT_PARSER_FIXTURES.find((candidate) => candidate.name === name);
    if (!fixture) throw new Error(`Missing parser fixture ${name}`);
    return fixture;
  };
  globalThis.__agentOutputParserCaptureAudit = runtime.auditAgentOutputParserCorpus;
  globalThis.__agentOutputParserCaptureAuditFlags = PARSER_AUDIT_FINDING_FLAGS;
  globalThis.__agentOutputParserCaptureActivityText = runtime.activityTextFromParsedAgentOutput;
  globalThis.__agentOutputParserCaptureContract = AGENT_OUTPUT_PARSER_CONTRACT;
  globalThis.__agentOutputParserCaptureFixtures = AGENT_OUTPUT_PARSER_FIXTURES;

  try {
    await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(js)}#${encodeURIComponent(sourceName)}`);
    await Promise.all(runtime.pending);
  } finally {
    delete globalThis.__agentOutputParserCaptureVitest;
    delete globalThis.__agentOutputParserCaptureFs;
    delete globalThis.__agentOutputParserCaptureParse;
    delete globalThis.__agentOutputParserCaptureMessages;
    delete globalThis.__agentOutputParserCaptureHarness;
    delete globalThis.__agentOutputParserCaptureGetFixture;
    delete globalThis.__agentOutputParserCaptureAudit;
    delete globalThis.__agentOutputParserCaptureAuditFlags;
    delete globalThis.__agentOutputParserCaptureActivityText;
    delete globalThis.__agentOutputParserCaptureContract;
    delete globalThis.__agentOutputParserCaptureFixtures;
  }

  return runtime;
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
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(value), { ...prettierOptions, parser: "json" }));
};

const fixtureCases = captureNamedFixtures();
const parserRuntime = await executeInstrumentedTest("src/agent-output-parser.test.ts");
const fixturesRuntime = await executeInstrumentedTest("src/agent-output-parser-fixtures.test.ts");
const compactRuntime = await executeInstrumentedTest("src/agent-output-parser-compact.test.ts");
const harnessRuntime = await executeInstrumentedTest("src/agent-output-parser-harness.test.ts");
realRmSync(new URL(PARSER_AUDIT_CORPUS_DIR, ROOT), { recursive: true, force: true });
const auditRuntime = await executeInstrumentedTest("src/agent-output-parser-audit.test.ts");
const activityRuntime = await executeInstrumentedTest("src/agent-output-activity-text.test.ts");
const fuzzRuntime = await executeInstrumentedTest("src/agent-output-parser-fuzz.test.ts");

const existingParser = await readExistingJson(PARSER_FIXTURE_PATH);
const parserContract = {
  ...existingParser,
  version: 1,
  source:
    "src/agent-output-parser-fixtures.ts, src/agent-output-parser.test.ts, src/agent-output-parser-fixtures.test.ts, src/agent-output-parser-compact.test.ts, src/agent-output-parser-harness.test.ts, src/agent-output-activity-text.test.ts",
  generatedBy: "scripts/capture-agent-output-parser-contract.mjs",
  description:
    "Agent output parser contract captured by running the TypeScript parser against fixture and test inputs.",
  cases: [
    ...fixtureCases,
    ...parserRuntime.cases,
    ...fixturesRuntime.cases,
    ...compactRuntime.cases,
    ...harnessRuntime.cases,
    ...activityRuntime.cases,
  ],
};

const fuzzContract = {
  version: 1,
  source: "src/agent-output-parser-fuzz.test.ts",
  generatedBy: "scripts/capture-agent-output-parser-contract.mjs",
  description: "Frozen deterministic parser fuzz corpus captured by running the TypeScript parser.",
  cases: fuzzRuntime.cases,
};

const auditContract = {
  version: 1,
  source: "src/agent-output-parser-audit.test.ts",
  generatedBy: "scripts/capture-agent-output-parser-contract.mjs",
  description: "Agent output parser audit contracts captured by running the TypeScript audit harness.",
  cases: auditRuntime.auditCases,
};

const activityContract = {
  version: 1,
  source: "src/agent-output-activity-text.test.ts",
  generatedBy: "scripts/capture-agent-output-parser-contract.mjs",
  description: "Agent output activity text contracts captured by running TypeScript activityTextFromParsedAgentOutput.",
  cases: activityRuntime.activityCases,
};

await writeJson(PARSER_FIXTURE_PATH, parserContract);
await writeJson(PARSER_FUZZ_PATH, fuzzContract);
await writeJson(PARSER_AUDIT_PATH, auditContract);
await writeJson(PARSER_ACTIVITY_PATH, activityContract);

console.log(
  JSON.stringify(
    {
      parserFixture: pathToFileURL(PARSER_FIXTURE_PATH.pathname).pathname,
      parserCases: parserContract.cases.length,
      fuzzFixture: pathToFileURL(PARSER_FUZZ_PATH.pathname).pathname,
      fuzzCases: fuzzContract.cases.length,
      auditFixture: pathToFileURL(PARSER_AUDIT_PATH.pathname).pathname,
      auditCases: auditContract.cases.length,
      activityFixture: pathToFileURL(PARSER_ACTIVITY_PATH.pathname).pathname,
      activityCases: activityContract.cases.length,
    },
    null,
    2,
  ),
);
