#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import prettier from "prettier";
import ts from "typescript";

const ROOT = new URL("../", import.meta.url);
const TRANSCRIPT_FIXTURE_PATH = new URL("testdata/contracts/v1/agent-output/transcript.json", ROOT);

const parserModule = await import(new URL("dist/agent-output-parser.js", ROOT));
const fixtureModule = await import(new URL("dist/agent-output-parser-fixtures.js", ROOT));
const richTextModule = await import(new URL("dist/rich-text.js", ROOT));
const transcriptModule = await import(new URL("dist/agent-transcript.js", ROOT));

const { parseAgentOutput } = parserModule;
const { AGENT_OUTPUT_PARSER_FIXTURES } = fixtureModule;
const { parseSgrRichTextLines } = richTextModule;
const {
  mergePublishedAttachments: realMergePublishedAttachments,
  messagesFromAgentOutput: realMessagesFromAgentOutput,
  messagesFromParsedAgentOutput: realMessagesFromParsedAgentOutput,
  transcriptMessageText: realTranscriptMessageText,
} = transcriptModule;

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const getParserFixture = (name) => {
  const fixture = AGENT_OUTPUT_PARSER_FIXTURES.find((candidate) => candidate.name === name);
  if (!fixture) throw new Error(`Missing parser fixture ${name}`);
  return fixture;
};

const expectProxy = new Proxy(function expectNoop() {}, {
  apply: () => expectProxy,
  get: () => expectProxy,
});

const serializeMessagesOptions = (options) => {
  const serialized = {};
  if (options?.richLines) serialized.richLines = options.richLines;
  return serialized;
};

const createCaptureRuntime = (sourceName) => {
  const cases = [];
  let currentTest = "module-scope";
  let callIndex = 0;

  const record = ({ api, input, output }) => {
    callIndex += 1;
    cases.push({
      id: `${sourceName.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}-${String(callIndex).padStart(3, "0")}`,
      name: currentTest,
      source: sourceName,
      api,
      input,
      output,
      inputSha256: hash(input),
    });
    return output;
  };

  const messagesFromParsedAgentOutput = (parsed, options = {}) => {
    const resolverHits = {};
    const wrappedOptions = { ...options };
    if (typeof options.attachmentContentForId === "function") {
      wrappedOptions.attachmentContentForId = (attachmentId) => {
        const value = options.attachmentContentForId(attachmentId);
        resolverHits[attachmentId] = value ?? null;
        return value;
      };
    }
    const output = realMessagesFromParsedAgentOutput(parsed, wrappedOptions);
    const serializedOptions = serializeMessagesOptions(options);
    if (typeof options.attachmentContentForId === "function") {
      serializedOptions.attachmentContentById = resolverHits;
    }
    return record({
      api: "messagesFromParsedAgentOutput",
      input: { parsed: parsed ?? null, options: serializedOptions },
      output,
    });
  };

  const messagesFromAgentOutput = (input) =>
    record({
      api: "messagesFromAgentOutput",
      input,
      output: realMessagesFromAgentOutput(input),
    });

  const transcriptMessageText = (parts) =>
    record({
      api: "transcriptMessageText",
      input: { parts },
      output: realTranscriptMessageText(parts),
    });

  const mergePublishedAttachments = (messages, published) =>
    record({
      api: "mergePublishedAttachments",
      input: { messages, published },
      output: realMergePublishedAttachments(messages, published),
    });

  const vitest = {
    describe: (_name, fn) => fn(),
    expect: expectProxy,
    it: (name, fn) => {
      currentTest = String(name);
      fn();
      currentTest = "module-scope";
    },
  };

  return {
    cases,
    globals: {
      getParserFixture,
      mergePublishedAttachments,
      messagesFromAgentOutput,
      messagesFromParsedAgentOutput,
      parseAgentOutput,
      parseSgrRichTextLines,
      transcriptMessageText,
      vitest,
    },
  };
};

const instrumentTestSource = (source) =>
  source
    .replace(/import\s+\{\s*describe,\s*expect,\s*it\s*\}\s+from\s+"vitest";\n/g, "")
    .replace(/import\s+\{[\s\S]*?\}\s+from\s+"\.\/agent-transcript\.js";\n/g, "")
    .replace(/import\s+\{\s*parseAgentOutput\s*\}\s+from\s+"\.\/agent-output-parser\.js";\n/g, "")
    .replace(/import\s+\{\s*parseSgrRichTextLines\s*\}\s+from\s+"\.\/rich-text\.js";\n/g, "")
    .replace(/import\s+\{\s*getParserFixture\s*\}\s+from\s+"\.\/agent-output-parser-test-utils\.js";\n/g, "");

const executeInstrumentedTest = async (sourceName) => {
  const runtime = createCaptureRuntime(sourceName);
  const source = await readFile(new URL(sourceName, ROOT), "utf8");
  const instrumented = [
    "const { describe, expect, it } = globalThis.__agentTranscriptCapture.vitest;",
    "const { getParserFixture, mergePublishedAttachments, messagesFromAgentOutput, messagesFromParsedAgentOutput, parseAgentOutput, parseSgrRichTextLines, transcriptMessageText } = globalThis.__agentTranscriptCapture;",
    instrumentTestSource(source),
  ].join("\n");
  const js = ts.transpileModule(instrumented, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: sourceName,
  }).outputText;

  globalThis.__agentTranscriptCapture = runtime.globals;
  try {
    await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(js)}#${encodeURIComponent(sourceName)}`);
  } finally {
    delete globalThis.__agentTranscriptCapture;
  }

  return runtime.cases;
};

const cases = await executeInstrumentedTest("src/agent-transcript.test.ts");
const contract = {
  version: 1,
  source: "src/agent-transcript.test.ts",
  generatedBy: "scripts/capture-agent-transcript-contract.mjs",
  description: "Agent transcript contract captured by running the TypeScript transcript projection APIs.",
  cases,
};

const prettierOptions = (await prettier.resolveConfig(TRANSCRIPT_FIXTURE_PATH.pathname)) ?? {};
await writeFile(
  TRANSCRIPT_FIXTURE_PATH,
  await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }),
);

console.log(
  JSON.stringify(
    {
      transcriptFixture: TRANSCRIPT_FIXTURE_PATH.pathname,
      cases: cases.length,
    },
    null,
    2,
  ),
);
