#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const TRACKER_FIXTURE_PATH = new URL("testdata/contracts/v1/agent-output/tracker.json", ROOT);

const { AgentTracker } = await import(new URL("dist/agent-tracker.js", ROOT));
const { loadMetadataState } = await import(new URL("dist/metadata-store.js", ROOT));
const { updateNotificationContext } = await import(new URL("dist/notification-context.js", ROOT));
const { initPaths } = await import(new URL("dist/paths.js", ROOT));

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

const baseScenarios = [
  {
    name: "prompt-to-task-done-increments-unseen-and-idle-time",
    actions: [
      {
        at: "2026-05-09T12:00:00.000Z",
        op: "emit",
        session: "s1",
        event: { kind: "prompt", message: "do the work", ts: "2026-05-09T12:00:00.000Z" },
      },
      {
        at: "2026-05-09T12:00:10.000Z",
        op: "emit",
        session: "s1",
        event: { kind: "task_done", message: "Done: auth", ts: "2026-05-09T12:00:10.000Z" },
      },
    ],
  },
  {
    name: "needs-input-mark-seen-preserves-attention-and-thread",
    actions: [
      {
        at: "2026-05-09T12:01:00.000Z",
        op: "emit",
        session: "s1",
        event: {
          kind: "needs_input",
          message: "Need your approval",
          threadId: "t-1",
          threadName: "Approval",
        },
      },
      { at: "2026-05-09T12:01:05.000Z", op: "markSeen", session: "s1" },
    ],
  },
  {
    name: "status-and-notify-derived-attention-counts",
    actions: [
      {
        at: "2026-05-09T12:02:00.000Z",
        op: "emit",
        session: "s1",
        event: { kind: "status", message: "Working on it", ts: "2026-05-09T12:02:00.000Z" },
      },
      {
        at: "2026-05-09T12:02:10.000Z",
        op: "emit",
        session: "s1",
        event: { kind: "status", message: "Need your input: press enter", ts: "2026-05-09T12:02:10.000Z" },
      },
      {
        at: "2026-05-09T12:02:20.000Z",
        op: "emit",
        session: "s1",
        event: { kind: "status", message: "Blocked waiting on deploy", ts: "2026-05-09T12:02:20.000Z" },
      },
      {
        at: "2026-05-09T12:02:30.000Z",
        op: "emit",
        session: "s1",
        event: { kind: "notify", message: "Build failed", tone: "error", ts: "2026-05-09T12:02:30.000Z" },
      },
      {
        at: "2026-05-09T12:02:40.000Z",
        op: "emit",
        session: "s1",
        event: { kind: "response", message: "Recovered.", ts: "2026-05-09T12:02:40.000Z" },
      },
    ],
  },
  {
    name: "explicit-setters-and-mark-seen-state",
    actions: [
      { at: "2026-05-09T12:03:00.000Z", op: "setActivity", session: "s1", activity: "running" },
      { at: "2026-05-09T12:03:05.000Z", op: "setAttention", session: "s1", attention: "needs_input" },
      { at: "2026-05-09T12:03:10.000Z", op: "emit", session: "s1", event: { kind: "response", message: "Done." } },
      { at: "2026-05-09T12:03:15.000Z", op: "setActivity", session: "s1", activity: "idle" },
      { at: "2026-05-09T12:03:20.000Z", op: "setAttention", session: "s1", attention: "normal" },
      { at: "2026-05-09T12:03:25.000Z", op: "markSeen", session: "s1" },
    ],
  },
  {
    name: "focused-session-suppresses-unseen-counts",
    actions: [
      {
        at: "2026-05-09T12:04:00.000Z",
        op: "focus",
        contextId: "tui",
        context: { focused: true, sessionId: "s1", panelOpen: false },
      },
      {
        at: "2026-05-09T12:04:05.000Z",
        op: "emit",
        session: "s1",
        event: { kind: "needs_input", message: "Need your reply" },
      },
      {
        at: "2026-05-09T12:04:10.000Z",
        op: "emit",
        session: "s1",
        event: { kind: "response", message: "Done." },
      },
    ],
  },
];

const eventTransitionCases = [
  { kind: "prompt", message: "user asked for work" },
  { kind: "response", message: "agent answered" },
  { kind: "status", message: "Working on it" },
  { kind: "task_assigned", message: "Task assigned" },
  { kind: "task_done", message: "Task done" },
  { kind: "task_failed", message: "Task failed", tone: "error" },
  { kind: "needs_input", message: "Need your input" },
  { kind: "blocked", message: "Blocked on deploy" },
  { kind: "interrupted", message: "Conversation interrupted" },
  { kind: "notify", message: "Notification" },
  { kind: "notify", message: "Error notification", tone: "error" },
];

const statusTransitionCases = [
  { name: "status-tone-error", event: { kind: "status", message: "Build exploded", tone: "error" } },
  { name: "status-needs-input-message", event: { kind: "status", message: "waiting for you to confirm approval" } },
  { name: "status-blocked-message", event: { kind: "status", message: "stuck waiting on deploy" } },
  { name: "status-success-tone", event: { kind: "status", message: "Looks good", tone: "success" } },
  { name: "status-done-word", event: { kind: "status", message: "work completed" } },
  { name: "status-running-word", event: { kind: "status", message: "indexing repository" } },
  { name: "status-neutral-no-state-change", event: { kind: "status", message: "FYI only" } },
];

const activityStates = ["idle", "running", "done", "error", "waiting", "interrupted"];
const attentionStates = ["normal", "needs_input", "blocked", "error", "needs_response"];

const scenarios = [
  ...baseScenarios,
  ...eventTransitionCases.map((event, index) => ({
    name: `single-event-${event.kind}${event.tone ? `-${event.tone}` : ""}`,
    actions: [
      {
        at: `2026-05-09T12:10:${String(index).padStart(2, "0")}.000Z`,
        op: "emit",
        session: "s1",
        event: {
          ...event,
          ts: `2026-05-09T12:10:${String(index).padStart(2, "0")}.000Z`,
        },
      },
    ],
  })),
  ...statusTransitionCases.map((entry, index) => ({
    name: entry.name,
    actions: [
      {
        at: `2026-05-09T12:11:${String(index).padStart(2, "0")}.000Z`,
        op: "emit",
        session: "s1",
        event: {
          ...entry.event,
          ts: `2026-05-09T12:11:${String(index).padStart(2, "0")}.000Z`,
        },
      },
    ],
  })),
  ...activityStates.map((activity, index) => ({
    name: `set-activity-${activity}`,
    actions: [
      {
        at: "2026-05-09T12:12:00.000Z",
        op: "setActivity",
        session: "s1",
        activity: "running",
      },
      {
        at: `2026-05-09T12:12:${String(index + 1).padStart(2, "0")}.000Z`,
        op: "setActivity",
        session: "s1",
        activity,
      },
    ],
  })),
  ...attentionStates.map((attention, index) => ({
    name: `set-attention-${attention}`,
    actions: [
      {
        at: `2026-05-09T12:13:${String(index).padStart(2, "0")}.000Z`,
        op: "setAttention",
        session: "s1",
        attention,
      },
    ],
  })),
];

const applyAction = (tracker, projectRoot, action) => {
  switch (action.op) {
    case "emit":
      tracker.emit(action.session, action.event, projectRoot);
      break;
    case "focus":
      updateNotificationContext(action.contextId, action.context, projectRoot);
      break;
    case "markSeen":
      tracker.markSeen(action.session, projectRoot);
      break;
    case "setActivity":
      tracker.setActivity(action.session, action.activity, projectRoot);
      break;
    case "setAttention":
      tracker.setAttention(action.session, action.attention, projectRoot);
      break;
    default:
      throw new Error(`Unknown tracker action ${action.op}`);
  }
};

const runScenario = async (scenario, index) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "aimux-agent-tracker-contract-"));
  mkdirSync(join(projectRoot, ".git"), { recursive: true });
  await initPaths(projectRoot);
  const tracker = new AgentTracker();
  const snapshots = [];

  try {
    for (const action of scenario.actions) {
      withClock(action.at, () => applyAction(tracker, projectRoot, action));
      snapshots.push({
        after: action,
        state: loadMetadataState(projectRoot),
      });
    }

    return {
      id: `agent-tracker-${String(index + 1).padStart(3, "0")}`,
      name: scenario.name,
      source: "scripts/capture-agent-tracker-contract.mjs",
      input: { actions: scenario.actions },
      output: {
        snapshots,
        finalState: loadMetadataState(projectRoot),
      },
      inputSha256: hash(scenario.actions),
    };
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
};

const cases = [];
for (let index = 0; index < scenarios.length; index += 1) {
  cases.push(await runScenario(scenarios[index], index));
}

const contract = {
  version: 1,
  source: "scripts/capture-agent-tracker-contract.mjs",
  generatedBy: "scripts/capture-agent-tracker-contract.mjs",
  description:
    "Agent tracker state-transition contracts captured by running the TypeScript AgentTracker against deterministic action sequences.",
  cases,
};

const prettierOptions = (await prettier.resolveConfig(TRACKER_FIXTURE_PATH.pathname)) ?? {};
await writeFile(
  TRACKER_FIXTURE_PATH,
  await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }),
);

console.log(
  JSON.stringify(
    {
      trackerFixture: TRACKER_FIXTURE_PATH.pathname,
      cases: cases.length,
    },
    null,
    2,
  ),
);
