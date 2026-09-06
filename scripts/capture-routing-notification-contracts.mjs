#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const ROUTING_FIXTURE = new URL("testdata/contracts/v1/orchestration/routing.json", ROOT);
const OSC_FIXTURE = new URL("testdata/contracts/v1/notifications/osc.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};
const recordCase = (prefix, index, name, source, api, input, output) => ({
  id: `${prefix}-${String(index + 1).padStart(3, "0")}`,
  name,
  source,
  api,
  input,
  output: output === undefined ? null : output,
  inputSha256: hash(input),
});

const routing = await import(new URL("dist/orchestration-routing.js", ROOT));
const osc = await import(new URL("dist/osc-notifications.js", ROOT));

const candidates = [
  {
    id: "claude-ui",
    tool: "claude",
    role: "ui",
    worktreePath: "/repo/ui",
    status: "idle",
    canReceiveInput: true,
    isAlive: true,
    workflowPressure: 0,
  },
  {
    id: "codex-ui",
    tool: "codex",
    role: "ui",
    worktreePath: "/repo/ui",
    status: "running",
    canReceiveInput: true,
    isAlive: true,
    workflowPressure: 4,
  },
  {
    id: "codex-coder",
    tool: "codex",
    role: "coder",
    worktreePath: "/repo/api",
    status: "waiting",
    canReceiveInput: true,
    isAlive: true,
    workflowPressure: 2,
  },
];

const routingCases = [];
const addRouting = (name, api, input) => {
  const output =
    api === "resolveOrchestrationTarget"
      ? routing.resolveOrchestrationTarget(input) ?? null
      : routing.resolveOrchestrationRecipients(input);
  routingCases.push(
    recordCase("orchestration-routing", routingCases.length, name, "src/orchestration-routing.test.ts", api, input, output),
  );
};

addRouting("prefers direct session targeting when provided", "resolveOrchestrationTarget", { candidates, to: "codex-coder" });
addRouting("routes by role and worktree", "resolveOrchestrationTarget", { candidates, assignee: "ui", worktreePath: "/repo/ui" });
addRouting("routes by tool when role is absent", "resolveOrchestrationTarget", { candidates, tool: "codex", worktreePath: "/repo/api" });
addRouting("returns routed recipients as a session id list", "resolveOrchestrationRecipients", { candidates, assignee: "ui", worktreePath: "/repo/ui" });
addRouting("preserves explicit multi-recipient targeting order for live sessions", "resolveOrchestrationRecipients", {
  candidates,
  to: ["codex-coder", "claude-ui"],
});
addRouting("prefers idle recipients over running ones", "resolveOrchestrationTarget", { candidates, assignee: "ui" });
addRouting("filters blocked recipients from implicit routing", "resolveOrchestrationRecipients", {
  candidates: [...candidates, { id: "blocked-ui", role: "ui", tool: "claude", status: "idle", canReceiveInput: false, isAlive: true }],
  assignee: "ui",
});
addRouting("prefers lower workflow pressure among equally available candidates", "resolveOrchestrationTarget", {
  candidates: [
    { id: "claude-ui-light", role: "ui", tool: "claude", status: "idle", canReceiveInput: true, isAlive: true, workflowPressure: 0 },
    { id: "claude-ui-loaded", role: "ui", tool: "claude", status: "idle", canReceiveInput: true, isAlive: true, workflowPressure: 6 },
  ],
  assignee: "ui",
});
addRouting("skips exited explicit recipients while preserving later live choices", "resolveOrchestrationRecipients", {
  candidates: [...candidates, { id: "old-codex", tool: "codex", exited: true }],
  to: ["old-codex", "codex-coder", "claude-ui"],
});

const oscCases = [];
const addOsc = (name, source, chunks) => {
  const parser = new osc.OscNotificationParser();
  const output = chunks.map((chunk) => parser.parseChunk(chunk));
  oscCases.push(recordCase("notifications-osc", oscCases.length, name, source, "OscNotificationParser.parseChunk", { chunks }, output));
};

addOsc("parses OSC 777 notifications and strips them from output", "src/osc-notifications.test.ts", [
  `before \u001b]777;notify;Title;Body\u0007 after`,
]);
addOsc("parses OSC 9 iTerm-style notifications", "src/osc-notifications.test.ts", [`\u001b]9;Hello world\u0007`]);
addOsc("ignores ConEmu OSC 9 subcommands", "src/osc-notifications.test.ts", [`\u001b]9;12\u0007prompt`]);
addOsc("parses OSC 99 Kitty title and body chunks", "src/osc-notifications.test.ts", [
  `\u001b]99;i=abc:d=0:p=title;Kitty Title\u0007`,
  `\u001b]99;i=abc:p=body;Kitty Body\u0007`,
]);
addOsc("buffers incomplete OSC sequences across chunks", "src/osc-notifications.test.ts", [
  "hello \u001b]777;notify;Ti",
  "tle;Body\u0007 world",
]);
addOsc("accepts ST terminators and Kitty base64 body payloads", "src/osc-notifications.ts", [
  `\u001b]99;i=b64:p=title;Encoded\u001b\\`,
  `\u001b]99;i=b64:p=body:e=1;${Buffer.from("snowman body", "utf8").toString("base64")}\u001b\\`,
]);
addOsc("ignores unsupported and malformed OSC notification payloads", "src/osc-notifications.ts", [
  "a\u001b]0;Window title\u0007b",
  "c\u001b]777;bad;Title;Body\u0007d",
  "e\u001b]99;p=unknown;ignored\u0007f",
]);

await writeContractJson(ROUTING_FIXTURE, {
  version: 1,
  source: "src/orchestration-routing.test.ts",
  generatedBy: "scripts/capture-routing-notification-contracts.mjs",
  description: "Orchestration recipient routing contracts captured by running the TypeScript routing helpers.",
  cases: routingCases,
});
await writeContractJson(OSC_FIXTURE, {
  version: 1,
  source: "src/osc-notifications.test.ts + src/osc-notifications.ts",
  generatedBy: "scripts/capture-routing-notification-contracts.mjs",
  description: "OSC terminal notification parse and clean-output contracts captured by running the TypeScript parser.",
  cases: oscCases,
});
console.log(`${ROUTING_FIXTURE.pathname}: ${routingCases.length} cases`);
console.log(`${OSC_FIXTURE.pathname}: ${oscCases.length} cases`);
