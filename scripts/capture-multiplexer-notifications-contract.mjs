#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/notifications.json", ROOT);

const {
  applyCoordinationFilter,
  applyCoordinationModel,
  notificationMutationInputForItem,
  notificationTargetLabel,
  notificationTargetState,
} = await import(new URL("dist/multiplexer/notifications.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function snapshotHost(host, fields) {
  const out = {};
  for (const field of fields) out[field] = clone(host[field] ?? null);
  return out;
}

function record(cases, name, api, input, run) {
  const output = run(input);
  cases.push({
    id: `multiplexer-notifications-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/multiplexer/notifications.test.ts",
    api,
    input,
    output,
    inputSha256: hash(input),
  });
}

const notificationA = {
  id: "note-live",
  title: "Live",
  body: "live agent needs input",
  sessionId: "live-1",
  kind: "needs_input",
  unread: true,
  cleared: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:01.000Z",
};

const notificationB = {
  id: "note-ghost",
  title: "Ghost",
  body: "missing agent needs input",
  sessionId: "ghost-1",
  kind: "thread",
  unread: true,
  cleared: false,
  createdAt: "2026-01-01T00:00:02.000Z",
  updatedAt: "2026-01-01T00:00:03.000Z",
};

const cases = [];

record(
  cases,
  "applies service coordination payload to legacy notification host fields",
  "applyCoordinationModel",
  {
    initialHost: { coordinationFilter: "all", coordinationIndex: 9, notificationIndex: 9 },
    payload: {
      model: {
        items: [
          {
            key: "session:live-1",
            sessionId: "live-1",
            reachability: "live",
            stale: false,
            actionable: true,
            notifications: [notificationA],
          },
          {
            key: "session:ghost-1",
            sessionId: "ghost-1",
            reachability: "missing",
            stale: true,
            actionable: false,
            notifications: [notificationB],
          },
        ],
      },
      worklist: {
        items: [
          { key: "n:live-1", kind: "notification", sessionId: "live-1", notification: { unreadCount: 1, notifications: [notificationA] } },
          { key: "t:thread-1", kind: "thread", thread: { thread: { id: "thread-1" } } },
          { key: "n:ghost-1", kind: "notification", sessionId: "ghost-1", notification: { unreadCount: 1, notifications: [notificationB] } },
        ],
      },
      threads: [{ thread: { id: "thread-1" }, displayTitle: "Thread" }],
    },
  },
  (input) => {
    const host = clone(input.initialHost);
    applyCoordinationModel(host, clone(input.payload));
    return snapshotHost(host, [
      "threadEntries",
      "coordinationModel",
      "notificationEntries",
      "notificationRowMeta",
      "coordinationWorklistAll",
      "coordinationWorklist",
      "coordinationLoaded",
      "coordinationIndex",
      "notificationIndex",
    ]);
  },
);

record(
  cases,
  "filters worklist to threads and clamps selection indexes",
  "applyCoordinationFilter",
  {
    initialHost: {
      coordinationFilter: "threads",
      coordinationIndex: 5,
      notificationIndex: 4,
      notificationEntries: [notificationA, notificationB],
      coordinationWorklistAll: [
        { key: "n:live-1", kind: "notification", sessionId: "live-1" },
        { key: "t:thread-1", kind: "thread", thread: { thread: { id: "thread-1" } } },
      ],
    },
  },
  (input) => {
    const host = clone(input.initialHost);
    applyCoordinationFilter(host);
    return snapshotHost(host, ["coordinationFilter", "coordinationWorklist", "coordinationIndex", "notificationIndex"]);
  },
);

record(
  cases,
  "all filter keeps notification and thread rows and initializes empty index",
  "applyCoordinationFilter",
  {
    initialHost: {
      coordinationFilter: "all",
      coordinationIndex: null,
      notificationIndex: 0,
      notificationEntries: [],
      coordinationWorklistAll: [
        { key: "n:live-1", kind: "notification", sessionId: "live-1" },
        { key: "t:thread-1", kind: "thread", thread: { thread: { id: "thread-1" } } },
      ],
    },
  },
  (input) => {
    const host = clone(input.initialHost);
    applyCoordinationFilter(host);
    return snapshotHost(host, ["coordinationFilter", "coordinationWorklist", "coordinationIndex", "notificationIndex"]);
  },
);

record(
  cases,
  "labels and states dashboard sessions, teammates, services, missing, and sessionless targets",
  "notificationTargetLabel+notificationTargetState",
  {
    targets: [null, "live-1", "team-1", "team-exited", "service-running", "service-offline", "missing-1"],
    host: {
      sessions: [{ id: "live-1", status: "running", command: "claude", label: "Claude", worktreeName: "main" }],
      teammates: [
        { id: "team-1", status: "offline", command: "codex", label: "Reviewer", worktreeName: "feature" },
        { id: "team-exited", status: "exited", command: "aider", label: "Aider" },
      ],
      services: [
        { id: "service-running", status: "running", command: "shell", label: "Shell", worktreeName: "ops" },
        { id: "service-offline", status: "offline", command: "server" },
      ],
    },
  },
  (input) => {
    const host = {
      dashboardTeammatesCache: clone(input.host.teammates),
      getDashboardSessions: () => clone(input.host.sessions),
      getDashboardServices: () => clone(input.host.services),
    };
    return input.targets.map((target) => ({
      target,
      label: notificationTargetLabel(host, target ?? undefined),
      state: notificationTargetState(host, target ?? undefined),
    }));
  },
);

record(
  cases,
  "derives notification mutation inputs for session and sessionless rollups",
  "notificationMutationInputForItem",
  {
    items: [
      {
        key: "n:live-1",
        kind: "notification",
        sessionId: "live-1",
        notification: { unreadCount: 1, notifications: [notificationA] },
      },
      {
        key: "n:sessionless",
        kind: "notification",
        notification: {
          unreadCount: 3,
          notifications: [{ id: "note-a" }, { id: "" }, { id: "note-b" }, {}],
        },
      },
      {
        key: "t:thread-1",
        kind: "thread",
        thread: { thread: { id: "thread-1" } },
      },
    ],
  },
  (input) => input.items.map((item) => notificationMutationInputForItem(clone(item))),
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/notifications.test.ts",
  subject: "multiplexer notification host helpers",
  generatedBy: "scripts/capture-multiplexer-notifications-contract.mjs",
  caseCount: cases.length,
  cases,
});
