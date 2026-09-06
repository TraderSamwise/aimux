#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/runtime-exchange/alert-routing.json", ROOT);

const routing = await import(new URL("dist/runtime-core/exchange-alert-routing.js", ROOT));
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

const cases = [];
function record(name, api, input, output) {
  cases.push({
    id: `runtime-exchange-alert-routing-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/runtime-core/exchange-alert-routing.test.ts",
    api,
    input,
    output,
    inputSha256: hash(input),
  });
}

record(
  "prefers explicit message recipients and excludes the sender",
  "resolveExchangeMessageAlertRecipients",
  {
    explicitRecipients: [" codex-1 ", "claude-lead", "codex-1"],
    message: { deliveredTo: ["ignored"] },
    fallbackRecipients: ["fallback"],
    from: "claude-lead",
  },
  routing.resolveExchangeMessageAlertRecipients({
    explicitRecipients: [" codex-1 ", "claude-lead", "codex-1"],
    message: { deliveredTo: ["ignored"] },
    fallbackRecipients: ["fallback"],
    from: "claude-lead",
  }),
);

for (const [name, input] of [
  ["falls back to delivered recipients", { message: { deliveredTo: ["codex-1"] } }],
  ["falls back to waiting actors", { thread: { waitingOn: ["reviewer"] } }],
  ["falls back to message recipients", { message: { to: ["claude-2"] } }],
  ["falls back to route recipients", { fallbackRecipients: ["fallback-1"] }],
]) {
  record(name, "resolveExchangeMessageAlertRecipients", input, routing.resolveExchangeMessageAlertRecipients(input));
}

for (const [name, input] of [
  [
    "explicit sender-only message recipients do not fall through",
    { explicitRecipients: ["claude-lead"], message: { deliveredTo: ["codex-1"] }, from: "claude-lead" },
  ],
  [
    "delivered sender-only message recipients do not fall through",
    { message: { deliveredTo: ["claude-lead"], to: ["codex-1"] }, from: "claude-lead" },
  ],
  [
    "waiting sender-only message recipients do not fall through",
    { thread: { waitingOn: ["claude-lead"] }, message: { to: ["codex-1"] }, from: "claude-lead" },
  ],
]) {
  record(name, "resolveExchangeMessageAlertRecipients", input, routing.resolveExchangeMessageAlertRecipients(input));
}

for (const [name, api, input, output] of [
  [
    "task assignment trims assignee",
    "resolveExchangeTaskAssignmentRecipient",
    { assignedTo: " codex-1 " },
    routing.resolveExchangeTaskAssignmentRecipient({ assignedTo: " codex-1 " }),
  ],
  ["task assignment empty", "resolveExchangeTaskAssignmentRecipient", {}, routing.resolveExchangeTaskAssignmentRecipient({})],
  [
    "task outcome uses assignedBy",
    "resolveExchangeTaskOutcomeRecipient",
    { task: { assignedBy: "claude-lead" } },
    routing.resolveExchangeTaskOutcomeRecipient({ task: { assignedBy: "claude-lead" } }),
  ],
  [
    "task outcome waiting actor overrides fallback lead",
    "resolveExchangeTaskOutcomeRecipient",
    { task: { assignedBy: "fallback-lead" }, thread: { waitingOn: ["claude-lead"] }, from: "codex-1" },
    routing.resolveExchangeTaskOutcomeRecipient({
      task: { assignedBy: "fallback-lead" },
      thread: { waitingOn: ["claude-lead"] },
      from: "codex-1",
    }),
  ],
  [
    "task outcome excludes sender",
    "resolveExchangeTaskOutcomeRecipient",
    { task: { assignedBy: "claude-lead" }, thread: { waitingOn: ["claude-lead"] }, from: "claude-lead" },
    routing.resolveExchangeTaskOutcomeRecipient({
      task: { assignedBy: "claude-lead" },
      thread: { waitingOn: ["claude-lead"] },
      from: "claude-lead",
    }),
  ],
  [
    "review outcome trims assignedBy",
    "resolveExchangeReviewOutcomeRecipient",
    { assignedBy: " claude-lead " },
    routing.resolveExchangeReviewOutcomeRecipient({ assignedBy: " claude-lead " }),
  ],
]) {
  record(name, api, input, output);
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/runtime-core/exchange-alert-routing.test.ts",
  generatedBy: "scripts/capture-exchange-alert-routing-contract.mjs",
  description: "Runtime exchange alert recipient routing contracts captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
