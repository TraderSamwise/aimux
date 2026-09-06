#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import ts from "typescript";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const STATUS_TONE_URL = new URL("app/lib/status-tone.ts", ROOT);
const ACTIVITY_LABEL_URL = new URL("app/lib/activity-label.ts", ROOT);
const FIXTURE_PATH = new URL("testdata/contracts/v1/app-display/status-activity.json", ROOT);

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
  agentStatusKind,
  aggregateStatusKind,
  appStatusColors,
  firstTokenOf,
  normalizeAppStatusKind,
  serviceStatusKind,
} = await importTypeScriptModule(STATUS_TONE_URL);
const { agentActivityLabel, shouldShimmerAgentActivityLabel } = await importTypeScriptModule(ACTIVITY_LABEL_URL);

function run(input) {
  if (input.api === "agentStatusKind") return agentStatusKind(input.session);
  if (input.api === "serviceStatusKind") return serviceStatusKind(input.service);
  if (input.api === "aggregateStatusKind") return aggregateStatusKind(input.kinds);
  if (input.api === "appStatusColors") return appStatusColors(input.value);
  if (input.api === "normalizeAppStatusKind") return normalizeAppStatusKind(input.value);
  if (input.api === "firstTokenOf") return firstTokenOf(input.command);
  if (input.api === "agentActivityLabel") return agentActivityLabel(input.activity, input.activityText);
  if (input.api === "shouldShimmerAgentActivityLabel") return shouldShimmerAgentActivityLabel(input.activity, input.label);
  throw new Error(`unknown api ${input.api}`);
}

const inputs = [
  { name: "maps running agent status to working tone", source: "app/lib/status-tone.test.ts", api: "agentStatusKind", session: { status: "running" } },
  { name: "maps waiting agent status to needs tone", source: "app/lib/status-tone.test.ts", api: "agentStatusKind", session: { status: "waiting" } },
  { name: "uses attention above raw running status", source: "app/lib/status-tone.test.ts", api: "agentStatusKind", session: { status: "running", attention: "needs_input" } },
  { name: "keeps blocked attention distinct", source: "app/lib/status-tone.test.ts", api: "agentStatusKind", session: { status: "running", attention: "blocked" } },
  { name: "keeps error attention distinct", source: "app/lib/status-tone.test.ts", api: "agentStatusKind", session: { status: "running", attention: "error" } },
  { name: "treats offline as offline before stale attention", source: "app/lib/status-tone.test.ts", api: "agentStatusKind", session: { status: "offline", attention: "needs_input" } },
  { name: "treats exited as offline before stale activity", source: "app/lib/status-tone.test.ts", api: "agentStatusKind", session: { status: "exited", activity: "done" } },
  { name: "pending actions force needs tone", source: "app/lib/status-tone.ts", api: "agentStatusKind", session: { status: "running", pendingAction: "restore" } },
  { name: "running services use service tone", source: "app/lib/status-tone.test.ts", api: "serviceStatusKind", service: { status: "running" } },
  { name: "offline services use service-off tone", source: "app/lib/status-tone.test.ts", api: "serviceStatusKind", service: { status: "offline" } },
  { name: "pending service actions force needs tone", source: "app/lib/status-tone.ts", api: "serviceStatusKind", service: { status: "offline", pendingAction: "stop" } },
  { name: "aggregates by status urgency", source: "app/lib/status-tone.test.ts", api: "aggregateStatusKind", kinds: ["working", "needs", "offline"] },
  { name: "keeps done above offline", source: "app/lib/status-tone.test.ts", api: "aggregateStatusKind", kinds: ["done", "offline"] },
  { name: "keeps first equally ranked offline kind", source: "app/lib/status-tone.test.ts", api: "aggregateStatusKind", kinds: ["serviceOff", "offline"] },
  { name: "returns null for empty aggregate", source: "app/lib/status-tone.ts", api: "aggregateStatusKind", kinds: [] },
  { name: "exposes native needs colors", source: "app/lib/status-tone.test.ts", api: "appStatusColors", value: "needs" },
  { name: "maps running colors through working tone", source: "app/lib/status-tone.test.ts", api: "appStatusColors", value: "running" },
  { name: "normalizes next step to needs tone", source: "app/lib/status-tone.ts", api: "normalizeAppStatusKind", value: "next_step" },
  { name: "normalizes unknown status to null", source: "app/lib/status-tone.ts", api: "normalizeAppStatusKind", value: "mystery" },
  { name: "extracts first command token", source: "app/lib/status-tone.ts", api: "firstTokenOf", command: "  codex --model gpt-5.5" },
  { name: "prefers tool words while running", source: "app/lib/activity-label.test.ts", api: "agentActivityLabel", activity: "running", activityText: "Jitterbugging… (2m 23s · ↓ 8.1k tokens)" },
  { name: "uses fallback working label while running", source: "app/lib/activity-label.test.ts", api: "agentActivityLabel", activity: "running", activityText: "" },
  { name: "waiting overrides stale spinner text", source: "app/lib/activity-label.test.ts", api: "agentActivityLabel", activity: "waiting", activityText: "Brewing…" },
  { name: "error overrides stale spinner text", source: "app/lib/activity-label.test.ts", api: "agentActivityLabel", activity: "error", activityText: "Brewing…" },
  { name: "idle activity says nothing", source: "app/lib/activity-label.test.ts", api: "agentActivityLabel", activity: "idle", activityText: "Brewing…" },
  { name: "missing activity says nothing", source: "app/lib/activity-label.test.ts", api: "agentActivityLabel", activityText: "Brewing…" },
  { name: "shimmers only while running with a label", source: "app/lib/activity-label.test.ts", api: "shouldShimmerAgentActivityLabel", activity: "running", label: "Hashing…" },
  { name: "does not shimmer while waiting", source: "app/lib/activity-label.test.ts", api: "shouldShimmerAgentActivityLabel", activity: "waiting", label: "Waiting for input" },
  { name: "does not shimmer without a label", source: "app/lib/activity-label.test.ts", api: "shouldShimmerAgentActivityLabel", activity: "running", label: null },
];

const cases = inputs.map((input, index) => ({
  id: `app-display-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: input.source,
  api: input.api,
  input,
  output: run(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: ["app/lib/status-tone.test.ts", "app/lib/activity-label.test.ts"],
  generatedBy: "scripts/capture-app-display-helpers-contract.mjs",
  description:
    "App status-tone and activity-label mapping, status urgency, native color, command-token, stale spinner, and shimmer behavior captured by running TypeScript app helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
