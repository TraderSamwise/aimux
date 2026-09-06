#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/tmux/window-open.json", ROOT);
const { openManagedSessionWindow, openManagedServiceWindow } = await import(new URL("dist/tmux/window-open.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

const agentTarget = {
  sessionName: "project-client-1",
  windowId: "@agent",
  windowIndex: 3,
  windowName: "codex",
};
const serviceTarget = {
  sessionName: "project-client-1",
  windowId: "@service",
  windowIndex: 4,
  windowName: "shell",
};
const dashboardTarget = {
  sessionName: "project-client-1",
  windowId: "@dashboard",
  windowIndex: 0,
  windowName: "dashboard",
};
const defaultManagedWindows = [
  {
    target: agentTarget,
    metadata: {
      kind: "agent",
      sessionId: "codex-1",
      backendSessionId: "backend-1",
      command: "codex",
      args: [],
      toolConfigKey: "codex",
    },
  },
  {
    target: serviceTarget,
    metadata: {
      kind: "service",
      sessionId: "service-1",
      command: "shell",
      args: [],
      toolConfigKey: "shell",
    },
  },
];

function makeRuntime(input) {
  const calls = [];
  const clients = input.clients ?? [];
  return {
    calls,
    isInsideTmux() {
      calls.push({ name: "isInsideTmux", args: [] });
      return Boolean(input.insideTmux);
    },
    currentClientSession() {
      calls.push({ name: "currentClientSession", args: [] });
      return input.runtimeCurrentClientSession ?? null;
    },
    listProjectManagedWindows(projectRoot) {
      calls.push({ name: "listProjectManagedWindows", args: [projectRoot] });
      return input.managedWindows ?? defaultManagedWindows;
    },
    isWindowAlive(target) {
      calls.push({ name: "isWindowAlive", args: [target] });
      return !input.liveWindowIds || input.liveWindowIds.includes(target.windowId);
    },
    openTarget(target, options) {
      calls.push({ name: "openTarget", args: [target, options] });
    },
    getTargetByWindowId(sessionName, windowId) {
      calls.push({ name: "getTargetByWindowId", args: [sessionName, windowId] });
      return (input.linkedTargets ?? []).find(
        (target) => target.sessionName === sessionName && target.windowId === windowId,
      );
    },
    findClientByTty(clientTty) {
      calls.push({ name: "findClientByTty", args: [clientTty] });
      return clients.find((client) => client.tty === clientTty);
    },
    listClients() {
      calls.push({ name: "listClients", args: [] });
      return clients;
    },
    getAttachedClientForTarget(target) {
      calls.push({ name: "getAttachedClientForTarget", args: [target] });
      return input.attachedClient ?? undefined;
    },
    switchClientToTarget(clientTty, target) {
      calls.push({ name: "switchClientToTarget", args: [clientTty, target] });
    },
    switchClient(sessionName, windowIndex) {
      calls.push({ name: "switchClient", args: [sessionName, windowIndex] });
    },
    refreshStatus() {
      calls.push({ name: "refreshStatus", args: [] });
    },
    sendFocusIn(target) {
      calls.push({ name: "sendFocusIn", args: [target] });
    },
    selectWindow(target) {
      calls.push({ name: "selectWindow", args: [target] });
    },
  };
}

const cases = [];
function record(name, api, input, run) {
  const runtime = makeRuntime(input);
  const target = run(runtime) ?? null;
  const fullInput = { name, ...input };
  cases.push({
    id: `tmux-window-open-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/tmux/window-open.ts",
    api,
    input: fullInput,
    output: { target, calls: runtime.calls },
    inputSha256: hash(fullInput),
  });
}

record(
  "opens agent windows from project managed windows",
  "openManagedSessionWindow",
  { projectRoot: "/repo", entry: { id: "codex-1", tmuxWindowId: "@agent" } },
  (runtime) => openManagedSessionWindow(runtime, "/repo", { id: "codex-1", tmuxWindowId: "@agent" }),
);
record(
  "opens agent windows by backend session id",
  "openManagedSessionWindow",
  { projectRoot: "/repo", entry: { id: "codex-new", backendSessionId: "backend-1" } },
  (runtime) => openManagedSessionWindow(runtime, "/repo", { id: "codex-new", backendSessionId: "backend-1" }),
);
record(
  "skips dead stale agent matches",
  "openManagedSessionWindow",
  {
    projectRoot: "/repo",
    entry: { id: "codex-1", backendSessionId: "backend-1" },
    liveWindowIds: ["@live-agent"],
    managedWindows: [
      {
        target: { sessionName: "project-client-1", windowId: "@dead-agent", windowIndex: 2, windowName: "codex" },
        metadata: { kind: "agent", sessionId: "codex-1", backendSessionId: "backend-1" },
      },
      {
        target: { sessionName: "project-client-1", windowId: "@live-agent", windowIndex: 5, windowName: "codex" },
        metadata: { kind: "agent", sessionId: "codex-1", backendSessionId: "backend-1" },
      },
    ],
  },
  (runtime) => openManagedSessionWindow(runtime, "/repo", { id: "codex-1", backendSessionId: "backend-1" }),
);
record(
  "prefers exact agent tmux window id over duplicate live match",
  "openManagedSessionWindow",
  {
    projectRoot: "/repo",
    entry: { id: "codex-1", tmuxWindowId: "@exact-agent" },
    liveWindowIds: ["@duplicate-agent", "@exact-agent"],
    managedWindows: [
      {
        target: { sessionName: "project-client-1", windowId: "@duplicate-agent", windowIndex: 2, windowName: "codex" },
        metadata: { kind: "agent", sessionId: "codex-1", backendSessionId: "backend-1" },
      },
      {
        target: { sessionName: "project-client-1", windowId: "@exact-agent", windowIndex: 5, windowName: "codex" },
        metadata: { kind: "agent", sessionId: "codex-1", backendSessionId: "backend-1" },
      },
    ],
  },
  (runtime) => openManagedSessionWindow(runtime, "/repo", { id: "codex-1", tmuxWindowId: "@exact-agent" }),
);
record(
  "opens service windows from project managed windows",
  "openManagedServiceWindow",
  { projectRoot: "/repo", service: "service-1" },
  (runtime) => openManagedServiceWindow(runtime, "/repo", "service-1"),
);
record(
  "prefers exact service tmux window id over duplicate live match",
  "openManagedServiceWindow",
  {
    projectRoot: "/repo",
    service: { id: "service-1", tmuxWindowId: "@exact-service" },
    liveWindowIds: ["@duplicate-service", "@exact-service"],
    managedWindows: [
      {
        target: {
          sessionName: "project-client-1",
          windowId: "@duplicate-service",
          windowIndex: 4,
          windowName: "shell",
        },
        metadata: { kind: "service", sessionId: "service-1" },
      },
      {
        target: { sessionName: "project-client-1", windowId: "@exact-service", windowIndex: 6, windowName: "shell" },
        metadata: { kind: "service", sessionId: "service-1" },
      },
    ],
  },
  (runtime) => openManagedServiceWindow(runtime, "/repo", { id: "service-1", tmuxWindowId: "@exact-service" }),
);
record(
  "selects linked target while already inside tmux",
  "openManagedSessionWindow",
  {
    projectRoot: "/repo",
    entry: { id: "codex-1", tmuxWindowId: "@agent" },
    insideTmux: true,
    runtimeCurrentClientSession: "project-client-live",
    linkedTargets: [{ ...agentTarget, sessionName: "project-client-live", windowIndex: 8 }],
  },
  (runtime) => openManagedSessionWindow(runtime, "/repo", { id: "codex-1", tmuxWindowId: "@agent" }),
);
record(
  "focus context switches live client by preferred tty and sends dashboard focus",
  "openManagedSessionWindow",
  {
    projectRoot: "/repo",
    entry: { id: "dashboard-agent", tmuxWindowId: "@dashboard" },
    managedWindows: [{ target: dashboardTarget, metadata: { kind: "agent", sessionId: "dashboard-agent" } }],
    focusContext: { currentClientSession: "project-client-live", clientTty: "/dev/ttys001" },
    clients: [{ tty: "/dev/ttys001", sessionName: "project-client-live", windowId: "@agent", name: "client" }],
  },
  (runtime) =>
    openManagedSessionWindow(
      runtime,
      "/repo",
      { id: "dashboard-agent", tmuxWindowId: "@dashboard" },
      {
        currentClientSession: "project-client-live",
        clientTty: "/dev/ttys001",
      },
    ),
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-07T00:00:00.000Z",
  generatedBy: "scripts/capture-tmux-window-open-contract.mjs",
  source: "src/tmux/window-open.ts",
  subject: "src/tmux/window-open.ts",
  description:
    "managed tmux window opening captured by running TypeScript window-open helpers against a fake tmux runtime.",
  caseCount: cases.length,
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
