#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const RECENCY_PATH = new URL("testdata/contracts/v1/runtime-state/session-recency.json", ROOT);
const RESTORE_PATH = new URL("testdata/contracts/v1/runtime-state/session-restorability.json", ROOT);
const SEMANTICS_PATH = new URL("testdata/contracts/v1/runtime-state/session-semantics.json", ROOT);
const recency = await import(new URL("dist/session-recency.js", ROOT));
const restore = await import(new URL("dist/session-restorability.js", ROOT));
const semantics = await import(new URL("dist/session-semantics.js", ROOT));
const { sessionRecencyAnchor } = recency;
const { describeSessionRestorability } = restore;
const {
  deriveSessionSemantics,
  sessionDisplayStatusLabel,
  sessionSemanticAttentionScore,
  sessionSemanticCompactHint,
  sessionSemanticStatusLabel,
} = semantics;

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};
function record(cases, prefix, source, name, api, input, output) {
  cases.push({
    id: `${prefix}-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source,
    api,
    input,
    output,
    inputSha256: hash(input),
  });
}

const OUT = "2026-06-16T00:00:00.000Z";
const IDLE = "2026-06-15T00:00:00.000Z";
const PROMPT = "2026-06-16T00:05:00.000Z";
const USED = "2026-06-10T00:00:00.000Z";
const recencyCases = [];
for (const [name, input] of [
  ["anchors working to last output", { label: "working", lastOutputAt: OUT }],
  ["anchors ready to last output", { label: "ready", lastOutputAt: OUT }],
  ["returns null for working with no output yet", { label: "working" }],
  ["returns null for ready with no output yet", { label: "ready" }],
  ["idle prefers output", { label: "idle", lastOutputAt: OUT }],
  ["idle falls back to became-idle", { label: "idle", becameIdleAt: IDLE }],
  ["next_step falls back to became-idle", { label: "next_step", becameIdleAt: IDLE }],
  ["needs_input anchors to prompt time", { label: "needs_input", latestUnreadAt: PROMPT, lastOutputAt: OUT }],
  ["needs_response falls back to output", { label: "needs_response", lastOutputAt: OUT }],
  ["error labels failed", { label: "error", becameIdleAt: IDLE }],
  ["blocked labels blocked", { label: "blocked", lastOutputAt: OUT }],
  ["offline falls back to last used", { label: "offline", lastUsedAt: USED }],
  ["offline prefers output", { label: "offline", lastOutputAt: OUT }],
]) {
  record(recencyCases, "runtime-state-session-recency", "src/session-recency.test.ts", name, "sessionRecencyAnchor", input, sessionRecencyAnchor(input));
}

const restoreCases = [];
for (const [name, input] of [
  [
    "prefers toolConfigKey when checking exact backend resume support",
    {
      session: {
        id: "claude-custom-1",
        status: "offline",
        tool: "claude",
        command: "claude",
        toolConfigKey: "claude-custom",
        backendSessionId: "backend-1",
      },
      tools: {
        claude: { resumeArgs: [], resumeByBackendSessionId: false },
        "claude-custom": { resumeArgs: ["--resume", "{sessionId}"], resumeByBackendSessionId: true },
      },
    },
  ],
  [
    "reports custom tool config restore blockers by config key",
    {
      session: {
        id: "claude-custom-1",
        status: "offline",
        tool: "claude",
        command: "claude",
        toolConfigKey: "claude-custom",
        backendSessionId: "backend-1",
      },
      tools: {
        claude: { resumeArgs: ["--resume", "{sessionId}"], resumeByBackendSessionId: true },
        "claude-custom": { resumeArgs: [], resumeByBackendSessionId: false },
      },
    },
  ],
  [
    "revalidates precomputed ready state against exact backend resume requirements",
    {
      session: { id: "claude-stale-ready", status: "offline", command: "claude", toolConfigKey: "claude", restoreState: "ready" },
      tools: { claude: { resumeArgs: ["--resume", "{sessionId}"], resumeByBackendSessionId: true } },
    },
  ],
  [
    "allows backend-less offline sessions that are safe to relaunch fresh",
    {
      session: { id: "codex-empty", status: "offline", command: "codex", toolConfigKey: "codex", freshRelaunchAllowed: true },
      tools: { codex: { resumeArgs: ["resume", "{sessionId}"], resumeByBackendSessionId: true } },
    },
  ],
  [
    "keeps persisted restore blockers ahead of backend ids",
    {
      session: {
        id: "claude-crashed",
        status: "offline",
        command: "claude",
        toolConfigKey: "claude",
        backendSessionId: "backend-1",
        restoreBlockedReason: "agent exited during startup",
      },
      tools: { claude: { resumeArgs: ["--resume", "{sessionId}"], resumeByBackendSessionId: true } },
    },
  ],
]) {
  record(restoreCases, "runtime-state-session-restorability", "src/session-restorability.test.ts", name, "describeSessionRestorability", input, describeSessionRestorability(input.session, input.tools));
}

function semanticObservation(input, rawStatus = input.status) {
  const semantic = deriveSessionSemantics(input);
  return {
    runtimeCanReceiveInput: semantic.runtime.canReceiveInput,
    userLabel: semantic.user.label,
    userAttention: semantic.user.attention,
    orchestrationPressure: semantic.orchestration.pressure,
    orchestrationCanBeAssignedWork: semantic.orchestration.canBeAssignedWork,
    statusLabel: sessionSemanticStatusLabel(semantic, rawStatus),
    compactHint: sessionSemanticCompactHint(semantic),
    attentionScore: sessionSemanticAttentionScore(semantic),
    notificationUnreadCount: semantic.notifications.unreadCount,
    notificationLatestText: semantic.notifications.latestText,
    notificationHasLatestUnread: semantic.notifications.latestUnread !== undefined,
  };
}
const semanticsCases = [];
for (const [name, input, rawStatus] of [
  ["keeps explicit needs-input as user attention without making workflow authoritative", { status: "idle", attention: "needs_input", unseenCount: 1, workflowOnMeCount: 1 }],
  ["distinguishes plain response waits from formal input prompts", { status: "idle", attention: "needs_response" }],
  ["labels idle assigned-task sessions as needing a next step", { status: "idle", attention: "normal", hasActiveTask: true }],
  ["keeps blocked workflow as orchestration pressure instead of primary user state", { status: "idle", workflowBlockedCount: 1 }],
  ["blocks input only for real tool/runtime blockers", { status: "running", attention: "blocked" }],
  ["treats idle task-free sessions as assignable", { status: "idle", attention: "normal" }],
  ["labels alive sessions without active work as ready", { status: "running", attention: "normal" }],
  ["keeps explicit activity as working", { status: "running", activity: "running", attention: "normal" }],
  ["notification unread compact hint", { status: "idle", attention: "normal", notificationUnreadCount: 3 }],
  ["raw new activity compact hint", { status: "idle", attention: "normal", unseenCount: 3 }],
  ["accepts API-provided latest notification text without a local notification record", { status: "running", notificationUnreadCount: 1, latestNotificationText: "Claude needs input" }],
]) {
  record(semanticsCases, "runtime-state-session-semantics", "src/session-semantics.test.ts", name, "deriveSessionSemantics", { input, rawStatus }, semanticObservation(input, rawStatus));
}
record(semanticsCases, "runtime-state-session-semantics", "src/session-semantics.test.ts", "keeps raw dashboard status fallback labels in the semantic display helper", "sessionDisplayStatusLabel", {
  inputs: [{ status: "running" }, { status: "idle" }, { status: "waiting" }, { status: "exited" }, { status: "offline" }],
}, [{ status: "running" }, { status: "idle" }, { status: "waiting" }, { status: "exited" }, { status: "offline" }].map((input) => sessionDisplayStatusLabel(input)));
const pendingSemantic = deriveSessionSemantics({ status: "running", attention: "needs_input" });
record(semanticsCases, "runtime-state-session-semantics", "src/session-semantics.test.ts", "keeps pending action labels authoritative over semantic user state", "sessionDisplayStatusLabel", {
  semanticInput: { status: "running", attention: "needs_input" },
  pendingActions: ["creating", "forking", "migrating", "starting", "stopping", "graveyarding", "renaming"],
}, {
  semanticDisplay: sessionDisplayStatusLabel({ status: "running", semantic: pendingSemantic }),
  pendingDisplays: ["creating", "forking", "migrating", "starting", "stopping", "graveyarding", "renaming"].map((pendingAction) =>
    sessionDisplayStatusLabel({ status: "running", pendingAction, semantic: pendingSemantic }),
  ),
});

await writeContractJson(RECENCY_PATH, {
  version: 1,
  source: "src/session-recency.test.ts",
  generatedBy: "scripts/capture-session-semantics-contract.mjs",
  description: "Session recency anchor contracts captured by running TypeScript.",
  cases: recencyCases,
});
await writeContractJson(RESTORE_PATH, {
  version: 1,
  source: "src/session-restorability.test.ts",
  generatedBy: "scripts/capture-session-semantics-contract.mjs",
  description: "Offline session restorability contracts captured by running TypeScript.",
  cases: restoreCases,
});
await writeContractJson(SEMANTICS_PATH, {
  version: 1,
  source: "src/session-semantics.test.ts",
  generatedBy: "scripts/capture-session-semantics-contract.mjs",
  description: "Session semantic label, attention, compact hint, notification, and display contracts captured by running TypeScript.",
  cases: semanticsCases,
});
console.log(`${RECENCY_PATH.pathname}: ${recencyCases.length} cases`);
console.log(`${RESTORE_PATH.pathname}: ${restoreCases.length} cases`);
console.log(`${SEMANTICS_PATH.pathname}: ${semanticsCases.length} cases`);
