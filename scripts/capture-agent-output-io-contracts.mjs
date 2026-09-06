#!/usr/bin/env node
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const BOUNDS_FIXTURE_PATH = new URL("testdata/contracts/v1/agent-output/bounds.json", ROOT);
const STREAM_FIXTURE_PATH = new URL("testdata/contracts/v1/agent-output/stream.json", ROOT);
const READ_METRICS_FIXTURE_PATH = new URL("testdata/contracts/v1/agent-output/read-metrics.json", ROOT);

const boundsModule = await import(new URL("dist/agent-output-bounds.js", ROOT));
const streamModule = await import(new URL("dist/agent-output-stream.js", ROOT));
const metricsModule = await import(new URL("dist/agent-output-read-metrics.js", ROOT));

const {
  DEFAULT_AGENT_OUTPUT_START_LINE,
  MAX_AGENT_OUTPUT_CAPTURE_LINES,
  agentOutputCaptureWindow,
  boundedAgentOutputEndLine,
  boundedAgentOutputStartLine,
} = boundsModule;
const { createAgentOutputSseTextHandler } = streamModule;
const { getAgentOutputReadMetrics, recordAgentOutputReadMetric, resetAgentOutputReadMetrics } = metricsModule;

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const withClock = (iso, fn) => {
  const RealDate = Date;
  const fixed = new RealDate(iso);

  class FixedDate extends RealDate {
    constructor(...args) {
      super(...(args.length > 0 ? args : [fixed.getTime()]));
    }

    static now() {
      return fixed.getTime();
    }
  }

  globalThis.Date = FixedDate;
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
};

const writeContractJson = async (url, contract) => {
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

const captureBounds = () => {
  const inputs = [undefined, -999_999, -2_000, -120, -80, -1, 0, 25, 1_999, 2_000, 4_096];
  const cases = inputs.map((startLine, index) => {
    const input = startLine === undefined ? {} : { startLine };
    const boundedStart = boundedAgentOutputStartLine(startLine);
    return {
      id: `agent-output-bounds-${String(index + 1).padStart(3, "0")}`,
      name: startLine === undefined ? "default-start-line" : `start-line-${startLine}`,
      source: "src/agent-output-bounds.ts",
      input,
      output: {
        boundedStartLine: boundedStart,
        boundedEndLine: boundedAgentOutputEndLine(boundedStart),
        captureWindow: agentOutputCaptureWindow(startLine),
      },
      inputSha256: hash(input),
    };
  });

  return {
    version: 1,
    source: "src/agent-output-bounds.ts",
    generatedBy: "scripts/capture-agent-output-io-contracts.mjs",
    description: "Agent output capture bounds captured by running the TypeScript bounds helpers.",
    constants: {
      DEFAULT_AGENT_OUTPUT_START_LINE,
      MAX_AGENT_OUTPUT_CAPTURE_LINES,
    },
    cases,
  };
};

const streamScenarios = [
  {
    name: "incremental-output-without-duplicate-frames",
    chunks: ['event: output\ndata: {"output":"one"}\n\n', 'event: output\ndata: {"output":"one\\ntwo"}\n\n'],
  },
  {
    name: "tail-notice-written-once",
    chunks: [
      'event: output\ndata: {"output":"tail","captureLineLimit":2000,"outputTailOnly":true}\n\n',
      'event: output\ndata: {"output":"tail\\nnew","captureLineLimit":2000,"outputTailOnly":true}\n\n',
    ],
  },
  {
    name: "sliding-tail-overlap-diff",
    chunks: [
      'event: output\ndata: {"output":"a\\nb\\nc","captureLineLimit":3,"outputTailOnly":true}\n\n',
      'event: output\ndata: {"output":"b\\nc\\nd","captureLineLimit":3,"outputTailOnly":true}\n\n',
    ],
  },
  {
    name: "split-sse-block-and-ready-comment-ignore",
    chunks: [": keepalive\n\n", "event: ready\ndata: {}\n\n", 'event: output\ndata: {"output":"alpha', '\\nbeta"}\n\n'],
  },
  {
    name: "resync-when-output-loses-prefix",
    chunks: ['event: output\ndata: {"output":"old tail"}\n\n', 'event: output\ndata: {"output":"fresh"}\n\n'],
  },
  {
    name: "error-event-throws-payload-message",
    chunks: ['event: error\ndata: {"error":"pane unavailable"}\n\n'],
  },
];

const captureStream = () => {
  const cases = streamScenarios.map((scenario, index) => {
    const writes = [];
    const errors = [];
    const handler = createAgentOutputSseTextHandler("codex-1", (text) => writes.push(text));
    for (const chunk of scenario.chunks) {
      try {
        handler.pushChunkText(chunk);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    const input = { sessionId: "codex-1", chunks: scenario.chunks };
    return {
      id: `agent-output-stream-${String(index + 1).padStart(3, "0")}`,
      name: scenario.name,
      source: "src/agent-output-stream.ts",
      input,
      output: {
        writes,
        text: writes.join(""),
        errors,
      },
      inputSha256: hash(input),
    };
  });

  return {
    version: 1,
    source: "src/agent-output-stream.ts",
    generatedBy: "scripts/capture-agent-output-io-contracts.mjs",
    description: "Agent output SSE text handler contracts captured by running the TypeScript stream handler.",
    cases,
  };
};

const readMetricScenarios = [
  {
    name: "counts-source-mode-purpose-bytes-and-change-state",
    records: [
      {
        at: "2026-05-09T13:00:00.000Z",
        input: {
          source: "output-stream",
          sessionId: "codex-1",
          mode: "chat",
          purpose: "initial",
          requestedStartLine: -120,
          startLine: -120,
          outputBytes: 42,
          durationMs: 5,
          responseBytes: 21,
          changed: true,
        },
      },
      {
        at: "2026-05-09T13:00:01.000Z",
        input: {
          source: "output-stream",
          sessionId: "codex-1",
          mode: "full",
          purpose: "terminal",
          requestedStartLine: -120,
          startLine: -120,
          outputBytes: 42,
          responseBytes: 11,
          durationMs: 7,
          coalesced: true,
          changed: false,
        },
      },
      {
        at: "2026-05-09T13:00:02.000Z",
        input: {
          source: "events",
          sessionId: "claude-1",
          mode: "chat",
          purpose: "history",
          durationMs: 9,
          error: "history missing",
        },
      },
    ],
  },
  {
    name: "recent-reads-are-bounded-to-last-100",
    records: Array.from({ length: 120 }, (_value, index) => ({
      at: `2026-05-09T13:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      input: {
        source: "live-pane-output",
        sessionId: `session-${index}`,
        durationMs: 1,
      },
    })),
  },
];

const captureReadMetrics = () => {
  const cases = readMetricScenarios.map((scenario, index) => {
    resetAgentOutputReadMetrics();
    const snapshots = [];
    const checkpointIndexes = new Set([0, 1, 2, 99, scenario.records.length - 1]);
    for (const [recordIndex, record] of scenario.records.entries()) {
      withClock(record.at, () => recordAgentOutputReadMetric(record.input));
      if (checkpointIndexes.has(recordIndex)) {
        snapshots.push({
          afterRecordIndex: recordIndex,
          after: record,
          metrics: getAgentOutputReadMetrics(),
        });
      }
    }
    const input = { records: scenario.records };
    return {
      id: `agent-output-read-metrics-${String(index + 1).padStart(3, "0")}`,
      name: scenario.name,
      source: "src/agent-output-read-metrics.ts",
      input,
      output: {
        snapshots,
        finalMetrics: getAgentOutputReadMetrics(),
      },
      inputSha256: hash(input),
    };
  });
  resetAgentOutputReadMetrics();

  return {
    version: 1,
    source: "src/agent-output-read-metrics.ts",
    generatedBy: "scripts/capture-agent-output-io-contracts.mjs",
    description: "Agent output read metric contracts captured by running the TypeScript metric accumulator.",
    cases,
  };
};

const boundsContract = captureBounds();
const streamContract = captureStream();
const readMetricsContract = captureReadMetrics();

await writeContractJson(BOUNDS_FIXTURE_PATH, boundsContract);
await writeContractJson(STREAM_FIXTURE_PATH, streamContract);
await writeContractJson(READ_METRICS_FIXTURE_PATH, readMetricsContract);

console.log(
  JSON.stringify(
    {
      boundsCases: boundsContract.cases.length,
      streamCases: streamContract.cases.length,
      readMetricsCases: readMetricsContract.cases.length,
    },
    null,
    2,
  ),
);
