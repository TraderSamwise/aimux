#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const INTERACTION_PATH = new URL("testdata/contracts/v1/metadata-server/interaction-display.json", ROOT);
const OUTPUT_PREVIEWS_PATH = new URL("testdata/contracts/v1/metadata-server/output-previews.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

const interactionDisplay = await import(new URL("dist/metadata-server/interaction-display.js", ROOT));
const outputPreviews = await import(new URL("dist/metadata-server/output-previews.js", ROOT));

function recordCase(prefix, index, name, source, api, input, output) {
  return {
    id: `${prefix}-${String(index + 1).padStart(3, "0")}`,
    name,
    source,
    api,
    input,
    output,
    inputSha256: hash(input),
  };
}

function captureInteractionDisplay() {
  const source = "src/metadata-server/interaction-display.test.ts";
  const inputs = [
    {
      name: "formats question payloads with option labels",
      api: "summarizeInteractionForDisplay",
      input: {
        sessionId: "codex-one",
        type: "question",
        payload: {
          questions: [
            {
              question: "Which branch?",
              options: [{ label: "master" }, "current HEAD"],
            },
            {
              question: "Run tests?",
              options: [{ label: "yes" }, { label: "no" }],
            },
          ],
        },
      },
    },
    {
      name: "does not show raw JSON summaries as user-facing text",
      api: "summarizeInteractionForDisplay",
      input: {
        sessionId: "claude-one",
        type: "permission",
        payload: {},
        summary: JSON.stringify({ toolName: "Bash" }),
      },
    },
    {
      name: "falls back to a parsed question summary when payload has no prompt",
      api: "summarizeInteractionForDisplay",
      input: {
        sessionId: "codex-two",
        type: "question",
        payload: {},
        summary: JSON.stringify({
          question: "Continue?",
          options: [{ label: "yes" }, "no"],
        }),
      },
    },
    {
      name: "uses trimmed readable summary for non-question interactions",
      api: "summarizeInteractionForDisplay",
      input: {
        sessionId: "codex-three",
        type: "approval",
        payload: {},
        summary: "  Run cargo test?  ",
      },
    },
    {
      name: "drops blank question options and keeps a single prompt unnumbered",
      api: "summarizeInteractionForDisplay",
      input: {
        sessionId: "codex-four",
        type: "question",
        payload: {
          question: "Pick target",
          options: ["  ", { label: " local " }, { value: "ignored" }, "remote"],
        },
      },
    },
  ];
  const cases = inputs.map((item, index) =>
    recordCase(
      "metadata-interaction-display",
      index,
      item.name,
      source,
      item.api,
      item.input,
      interactionDisplay.summarizeInteractionForDisplay(item.input),
    ),
  );
  return {
    version: 1,
    source,
    generatedBy: "scripts/capture-metadata-server-helpers-contract.mjs",
    description:
      "Metadata-server interaction display title/message/summary behavior captured by running TypeScript summarizeInteractionForDisplay.",
    cases,
  };
}

function normalizeMeasurement(measurement) {
  return {
    result: measurement.result,
    coalesced: measurement.coalesced,
    duration: typeof measurement.durationMs === "number" ? "<duration-ms>" : measurement.durationMs,
  };
}

async function runOutputPreviewCase(input) {
  switch (input.api) {
    case "mergeExposePreviewSnapshots":
      return outputPreviews.mergeExposePreviewSnapshots(input.captureSnapshot, input.tapSnapshot);
    case "measureAgentOutputReadSequence": {
      const calls = [];
      const coordinator = new outputPreviews.ProjectOutputPreviewCoordinator({
        currentProjectRoot: () => process.cwd(),
        isServerRunning: () => true,
        readAgentOutput: (readInput) => {
          calls.push({
            sessionId: readInput.sessionId,
            startLine: readInput.startLine,
            mode: readInput.mode,
            purpose: readInput.purpose,
          });
          const matching = input.readOutputs.find((entry) => entry.match.mode === readInput.mode && entry.match.purpose === readInput.purpose);
          return {
            sessionId: readInput.sessionId,
            output: matching?.output ?? "",
            startLine: readInput.startLine,
          };
        },
        exposePreviewCache: false,
        exposePaneOutputTap: false,
        exposeHotSnapshots: false,
        runInProjectContext: (fn) => fn(),
      });
      const measurements = [];
      for (const read of input.reads) {
        measurements.push(normalizeMeasurement(await coordinator.measureAgentOutputRead(read.source, read.input)));
      }
      return { measurements, calls };
    }
    case "touchVisualClientLease": {
      const coordinator = new outputPreviews.ProjectOutputPreviewCoordinator({
        currentProjectRoot: () => process.cwd(),
        isServerRunning: () => true,
        exposePreviewCache: false,
        exposePaneOutputTap: false,
        exposeHotSnapshots: false,
        runInProjectContext: (fn) => fn(),
      });
      const touches = input.touches.map((touch) => {
        const req = { socket: { remoteAddress: touch.remoteAddress } };
        const active = coordinator.touchVisualClientLease(req, new URL(touch.url), touch.input);
        return { active };
      });
      const diagnostics = coordinator.diagnostics();
      return {
        touches,
        diagnostics: {
          clients: diagnostics.clients,
          cache: diagnostics.cache,
          taps: diagnostics.taps,
          hotSnapshots: {
            enabled: diagnostics.hotSnapshots.enabled,
            scheduled: diagnostics.hotSnapshots.scheduled,
            refreshing: diagnostics.hotSnapshots.refreshing,
            workerRunning: diagnostics.hotSnapshots.workerRunning,
          },
        },
      };
    }
    case "defaultDiagnostics": {
      const coordinator = new outputPreviews.ProjectOutputPreviewCoordinator({
        currentProjectRoot: () => process.cwd(),
        isServerRunning: () => true,
        runInProjectContext: (fn) => fn(),
      });
      return coordinator.diagnostics();
    }
    default:
      throw new Error(`unknown output preview api ${input.api}`);
  }
}

function normalizeLeaseTimes(value) {
  const seen = new Map();
  let next = 1;
  const visit = (node) => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== "object") return node;
    const out = {};
    for (const [key, child] of Object.entries(node)) {
      if ((key === "startedAt" || key === "updatedAt" || key === "expiresAt") && typeof child === "string") {
        if (!seen.has(child)) seen.set(child, `<ts:${next++}>`);
        out[key] = seen.get(child);
      } else {
        out[key] = visit(child);
      }
    }
    return out;
  };
  return visit(value);
}

async function captureOutputPreviews() {
  const source = "src/metadata-server/output-previews.test.ts";
  const inputs = [
    {
      name: "keeps capture output when it already includes tap output",
      api: "mergeExposePreviewSnapshots",
      captureSnapshot: {
        output: "one\ntwo\n",
        capturedAt: "2026-01-01T00:00:00.000Z",
        source: "capture",
        windowId: "@1",
      },
      tapSnapshot: { output: "two\n", capturedAt: "2026-01-01T00:00:01.000Z", source: "tap", windowId: "@1" },
    },
    {
      name: "extends capture output when tap output appends new text",
      api: "mergeExposePreviewSnapshots",
      captureSnapshot: {
        output: "one",
        capturedAt: "2026-01-01T00:00:00.000Z",
        source: "capture",
        windowId: "@1",
      },
      tapSnapshot: { output: "two", capturedAt: "2026-01-01T00:00:01.000Z", source: "tap", windowId: "@1" },
    },
    {
      name: "uses tap output when no capture snapshot exists",
      api: "mergeExposePreviewSnapshots",
      captureSnapshot: undefined,
      tapSnapshot: { output: "tap-only", capturedAt: "2026-01-01T00:00:01.000Z", source: "tap", windowId: "@2" },
    },
    {
      name: "coalesces repeated output reads for the same session and line",
      api: "measureAgentOutputReadSequence",
      readOutputs: [{ match: {}, output: "hello" }],
      reads: [
        { source: "events", input: { sessionId: "agent-1", startLine: -20 } },
        { source: "events", input: { sessionId: "agent-1", startLine: -20 } },
      ],
    },
    {
      name: "does not coalesce reads with different output modes or purposes",
      api: "measureAgentOutputReadSequence",
      readOutputs: [
        { match: { mode: "chat", purpose: "poll" }, output: "" },
        { match: { mode: "full", purpose: "poll" }, output: "terminal" },
        { match: { mode: "full", purpose: "interrupt" }, output: "terminal" },
      ],
      reads: [
        { source: "events", input: { sessionId: "agent-1", startLine: -20, mode: "chat", purpose: "poll" } },
        { source: "live-pane-output", input: { sessionId: "agent-1", startLine: -20, mode: "full", purpose: "poll" } },
        {
          source: "live-pane-output",
          input: { sessionId: "agent-1", startLine: -20, mode: "full", purpose: "interrupt" },
        },
      ],
    },
    {
      name: "does not touch visual client leases when no preview was requested",
      api: "touchVisualClientLease",
      touches: [
        {
          remoteAddress: "127.0.0.1",
          url: "http://localhost/agents",
          input: { surface: "expose", requestedPreview: false, requestedChatPreview: false },
        },
      ],
    },
    {
      name: "touches preview visual leases with sanitized fallback ids",
      api: "touchVisualClientLease",
      touches: [
        {
          remoteAddress: "::ffff:10.0.0.5",
          url: "http://localhost/agents?clientKind=web&clientTtlMs=2000",
          input: { surface: "dash board", requestedPreview: true, requestedChatPreview: false },
        },
      ],
    },
    {
      name: "keeps default preview readers disabled when no output reader is available",
      api: "defaultDiagnostics",
    },
  ];
  const cases = [];
  for (const input of inputs) {
    const output = await runOutputPreviewCase(input);
    cases.push(
      recordCase(
        "metadata-output-previews",
        cases.length,
        input.name,
        source,
        input.api,
        input,
        input.api === "touchVisualClientLease" ? normalizeLeaseTimes(output) : output,
      ),
    );
  }
  return {
    version: 1,
    source,
    generatedBy: "scripts/capture-metadata-server-helpers-contract.mjs",
    description:
      "Metadata-server output preview snapshot merge, output-read coalescing, visual lease touch, and diagnostics behavior captured by running TypeScript output-previews helpers. Lease timestamps are normalized after execution.",
    cases,
  };
}

await writeContractJson(INTERACTION_PATH, captureInteractionDisplay());
const outputContract = await captureOutputPreviews();
await writeContractJson(OUTPUT_PREVIEWS_PATH, outputContract);

console.log(`${INTERACTION_PATH.pathname}: 5 cases`);
console.log(`${OUTPUT_PREVIEWS_PATH.pathname}: ${outputContract.cases.length} cases`);
