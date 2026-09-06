#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import ts from "typescript";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/notifications/policy.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

async function transpile(path) {
  const url = new URL(path, ROOT);
  const source = await readFile(url, "utf8");
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: url.pathname,
  }).outputText;
}

function moduleUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

const notificationSettingsUrl = moduleUrl(await transpile("app/lib/notification-settings.ts"));
const statusToneUrl = moduleUrl(await transpile("app/lib/status-tone.ts"));
const agentDisplayUrl = moduleUrl(
  (await transpile("app/lib/agent-display.ts")).replace(
    /from ["']@\/lib\/status-tone["'];/g,
    `from "${statusToneUrl}";`,
  ),
);
const notificationPolicySource = (await transpile("app/lib/notification-policy.ts"))
  .replace(/from ["']@\/lib\/agent-display["'];/g, `from "${agentDisplayUrl}";`)
  .replace(/from ["']@\/lib\/notification-settings["'];/g, `from "${notificationSettingsUrl}";`);

const settingsModule = await import(notificationSettingsUrl);
const {
  evaluateAgentNotification,
  evaluateAlertEvent,
  evaluateNotificationRecord,
  evaluateNotificationRecordBatch,
  isRecentNotificationRecord,
  snapshotSessionForNotifications,
} = await import(moduleUrl(notificationPolicySource));

const fixedNow = Date.parse("2026-05-23T00:00:10.000Z");
Date.now = () => fixedNow;

const enabledSettings = { ...settingsModule.defaultNotificationSettings, enabled: true };
const projectContext = {
  projectName: "glyde-frontend",
  projectPath: "/Users/sam/cs/glyde-frontend",
};

function session(overrides = {}) {
  return {
    id: "claude-a1",
    command: "claude",
    status: "running",
    label: "claude",
    attention: "none",
    activity: "running",
    unseenCount: 0,
    ...overrides,
  };
}

function record(overrides = {}) {
  return {
    id: "notice-1",
    title: "Need input",
    body: "Approve deploy",
    sessionId: "claude-a1",
    kind: "needs_input",
    unread: true,
    cleared: false,
    createdAt: "2026-05-23T00:00:00.000Z",
    updatedAt: "2026-05-23T00:00:00.000Z",
    ...overrides,
  };
}

function run(input) {
  if (input.api === "snapshotSessionForNotifications") return snapshotSessionForNotifications(input.session);
  if (input.api === "evaluateAgentNotification") {
    return evaluateAgentNotification(input.session, input.previous, input.settings, input.context);
  }
  if (input.api === "evaluateNotificationRecord") {
    return evaluateNotificationRecord(input.record, input.settings, input.context);
  }
  if (input.api === "evaluateNotificationRecordBatch") {
    return evaluateNotificationRecordBatch(
      input.records,
      input.settings,
      input.context,
      new Set(input.observedIds ?? []),
      input.maxEvents,
    );
  }
  if (input.api === "evaluateAlertEvent") return evaluateAlertEvent(input.event, input.settings, input.context);
  if (input.api === "isRecentNotificationRecord") return isRecentNotificationRecord(input.record, input.nowMs);
  throw new Error(`unknown api ${input.api}`);
}

const previousNone = snapshotSessionForNotifications(session({ attention: "none" }));
const previousRunning = snapshotSessionForNotifications(session({ activity: "running" }));
const disabledNeedsInputSettings = {
  ...enabledSettings,
  categories: {
    ...enabledSettings.categories,
    agent: { ...enabledSettings.categories.agent, needsInput: false },
  },
};
const completedEnabledSettings = {
  ...enabledSettings,
  categories: {
    ...enabledSettings.categories,
    agent: { ...enabledSettings.categories.agent, completed: true },
  },
};

const inputs = [
  { name: "does not emit from the initial snapshot", api: "evaluateAgentNotification", session: session({ attention: "needs_input" }), settings: enabledSettings },
  { name: "uses compact generated labels in fallback bodies", api: "snapshotSessionForNotifications", session: session({ id: "codex-o6o4kf", label: "codex-o6o4kf", command: "codex --model gpt-5.5", role: "coder", headline: "" }) },
  { name: "emits when an agent starts needing input", api: "evaluateAgentNotification", session: session({ attention: "needs_input", headline: "Waiting for input" }), previous: previousNone, settings: enabledSettings, context: projectContext },
  { name: "honors needs-input category toggles", api: "evaluateAgentNotification", session: session({ attention: "needs_input" }), previous: previousNone, settings: disabledNeedsInputSettings },
  { name: "completion alerts are disabled by default", api: "evaluateAgentNotification", session: session({ status: "idle", activity: "done" }), previous: previousRunning, settings: enabledSettings },
  { name: "completion alerts emit when enabled", api: "evaluateAgentNotification", session: session({ status: "idle", activity: "done" }), previous: previousRunning, settings: completedEnabledSettings },
  { name: "activity alerts emit on unseen-count increase", api: "evaluateAgentNotification", session: session({ unseenCount: 2, previewLine: "New output" }), previous: snapshotSessionForNotifications(session({ unseenCount: 1 })), settings: { ...enabledSettings, categories: { ...enabledSettings.categories, agent: { ...enabledSettings.categories.agent, activity: true } } } },
  { name: "maps daemon notification records through category settings", api: "evaluateNotificationRecord", record: record(), settings: enabledSettings, context: projectContext },
  { name: "does not add duplicate project prefixes to server-labeled records", api: "evaluateNotificationRecord", record: record({ title: "[Needs input] aimux / notifications", body: "Agent is waiting for input.", projectName: "aimux", worktreeName: "notifications" }), settings: enabledSettings, context: { projectName: "aimux", projectPath: "/Users/sam/cs/aimux" } },
  { name: "maps live alert events without polling", api: "evaluateAlertEvent", event: { type: "alert", projectId: "glyde-frontend-123", kind: "needs_input", sessionId: "claude-a1", title: "claude needs input", message: "Agent is waiting for input.", ts: "2026-05-23T00:00:10.000Z", notificationId: "notice-1" }, settings: enabledSettings, context: projectContext },
  { name: "maps next-step live alert events to needs-input", api: "evaluateAlertEvent", event: { type: "alert", projectId: "aimux-123", kind: "next_step", sessionId: "codex-p4bb3m", title: "[Next step] aimux / notifications", message: "Agent stopped after a turn.", ts: "2026-05-23T00:00:10.000Z", notificationId: "notice-next-step" }, settings: enabledSettings, context: { projectName: "aimux", projectPath: "/Users/sam/cs/aimux" } },
  { name: "suppresses telemetry interaction alerts", api: "evaluateAlertEvent", event: { type: "alert", projectId: "aimux-123", kind: "interaction_request", sessionId: "codex-p4bb3m", title: "Permission", message: "Bash", ts: "2026-05-23T00:00:10.000Z", interaction: { id: "i1", type: "permission", telemetry: true } }, settings: enabledSettings },
  { name: "rejects stale records", api: "isRecentNotificationRecord", record: record({ id: "notice-old", createdAt: "2026-05-23T00:00:00.000Z" }), nowMs: Date.parse("2026-05-23T00:01:00.000Z") },
  { name: "does not notify stale records during polling", api: "evaluateNotificationRecord", record: record({ id: "notice-old", createdAt: "2026-05-23T00:00:00.000Z" }), settings: enabledSettings },
  { name: "maps next-step daemon records through needs-input", api: "evaluateNotificationRecord", record: record({ id: "notice-next-step", title: "[Next step] aimux / notifications", body: "Agent stopped after a turn.", sessionId: "codex-p4bb3m", kind: "next_step" }), settings: enabledSettings, context: { projectName: "aimux", projectPath: "/Users/sam/cs/aimux" } },
  { name: "maps task-failed records to error", api: "evaluateNotificationRecord", record: record({ id: "notice-error", title: "Failed", body: "Task failed", kind: "task_failed" }), settings: enabledSettings },
  { name: "maps notification records to activity", api: "evaluateNotificationRecord", record: record({ id: "notice-activity", title: "Activity", body: "Something happened", kind: "notification" }), settings: { ...enabledSettings, categories: { ...enabledSettings.categories, agent: { ...enabledSettings.categories.agent, activity: true } } } },
  { name: "emits every unobserved browser notification during catch-up", api: "evaluateNotificationRecordBatch", records: [record({ id: "notice-newest", title: "Newest", body: "Respond here", sessionId: "codex-2", createdAt: "2026-05-23T00:00:09.000Z" }), record({ id: "notice-older", title: "Older", body: "Also respond", sessionId: "codex-1", createdAt: "2026-05-23T00:00:08.000Z" })], settings: enabledSettings },
  { name: "skips durable records already delivered live", api: "evaluateNotificationRecordBatch", records: [record({ id: "notice-live", title: "Already live", body: "SSE handled this", sessionId: "codex-2", createdAt: "2026-05-23T00:00:09.000Z" }), record({ id: "notice-polled", title: "Polled", body: "Fallback delivery", sessionId: "codex-1", createdAt: "2026-05-23T00:00:08.000Z" })], settings: enabledSettings, observedIds: ["notice-live"] },
  { name: "respects record batch max events while observing all ids", api: "evaluateNotificationRecordBatch", records: [record({ id: "notice-a", title: "A" }), record({ id: "notice-b", title: "B" })], settings: enabledSettings, maxEvents: 1 },
  { name: "does not emit read records", api: "evaluateNotificationRecord", record: record({ unread: false }), settings: enabledSettings },
  { name: "does not emit cleared records", api: "evaluateNotificationRecord", record: record({ cleared: true }), settings: enabledSettings },
  { name: "does not emit disabled completed records", api: "evaluateNotificationRecord", record: record({ kind: "task_done" }), settings: enabledSettings },
];

const cases = inputs.map((input, index) => ({
  id: `notification-policy-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "app/lib/notification-policy.test.ts",
  api: input.api,
  input,
  output: run(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "app/lib/notification-policy.test.ts",
  generatedBy: "scripts/capture-notification-policy-contract.mjs",
  description:
    "App notification policy session snapshots, agent transitions, daemon record mapping, live alert mapping, stale filtering, category gates, dedupe keys, targets, and batch observation captured by running TypeScript notification-policy helpers with Date.now fixed.",
  normalization: {
    now: "Date.now is fixed to 2026-05-23T00:00:10.000Z before running TypeScript policy helpers.",
  },
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
