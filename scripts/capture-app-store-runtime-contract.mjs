#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import ts from "typescript";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const TEMP_DIR = new URL("app/node_modules/.contract-capture-app-store-runtime/", ROOT);
const OUTPUTS = {
  chat: new URL("testdata/contracts/v1/app-state/chat-output.json", ROOT),
  projects: new URL("testdata/contracts/v1/app-state/project-list.json", ROOT),
  resourceTracker: new URL(
    "testdata/contracts/v1/app-state/resource-request-tracker.json",
    ROOT,
  ),
  ui: new URL("testdata/contracts/v1/app-state/ui-defaults.json", ROOT),
};

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(
    url,
    await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }),
  );
}

async function writeTempModule(name, sourcePath, rewrite = (source) => source) {
  const source = rewrite(await readFile(new URL(sourcePath, ROOT), "utf8"));
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    },
    fileName: sourcePath,
  }).outputText;
  const url = new URL(name, TEMP_DIR);
  await writeFile(url, transpiled);
  return url;
}

function rewriteProjectsModule(source) {
  return source
    .replace(
      /import \{ createSsrSafeJsonStorage \} from "@\/lib\/jotai-storage";\n/,
      "const createSsrSafeJsonStorage = () => ({ getItem: () => null, setItem: () => undefined, removeItem: () => undefined });\n",
    )
    .replace(
      /import \{ getProjectServiceEndpoint \} from "@\/lib\/project-connection-display";\n/,
      "const getProjectServiceEndpoint = (project) => project?.serviceEndpoint ?? null;\n",
    )
    .replace(
      /import \{ desktopStateFamily \} from "@\/stores\/desktopState";\n/,
      "const desktopStateFamily = (_projectPath) => atom({ sessions: [] });\n",
    );
}

function rewriteTrackerModule(source) {
  return source.replace(
    /import \{[\s\S]*?\} from "@\/stores\/project";/,
    'import { isCurrentProjectResourceRequest, projectResourceRequestKey } from "./project-store.mjs";',
  );
}

await rm(TEMP_DIR, { force: true, recursive: true });
await mkdir(TEMP_DIR, { recursive: true });

const projectStoreUrl = await writeTempModule(
  "project-store.mjs",
  "app/stores/project.ts",
  rewriteProjectsModule,
);
const projectsUrl = await writeTempModule(
  "projects.mjs",
  "app/stores/projects.ts",
  rewriteProjectsModule,
);
const trackerUrl = await writeTempModule(
  "project-resource-request-tracker.mjs",
  "app/lib/project-resource-request-tracker.ts",
  rewriteTrackerModule,
);
const chatUrl = await writeTempModule("chat.mjs", "app/stores/chat.ts");
const uiUrl = await writeTempModule("ui.mjs", "app/stores/ui.ts");

const { createStore } = await import(new URL("app/node_modules/jotai/esm/vanilla.mjs", ROOT));
const projectStore = await import(projectStoreUrl);
const projects = await import(projectsUrl);
const trackerModule = await import(trackerUrl);
const chat = await import(chatUrl);
const ui = await import(uiUrl);

const fixedNow = Date.parse("2026-09-04T12:00:00.000Z");
let now = fixedNow;
const originalDateNow = Date.now;
Date.now = () => now;

function project(input) {
  return {
    dashboardSessionName: `aimux-${input.id}`,
    lastSeen: "2026-01-01T00:00:00.000Z",
    service: null,
    serviceAlive: true,
    serviceEndpoint: { host: "127.0.0.1", port: 43190 },
    ...input,
  };
}

function message(id, text, latest = true) {
  const value = {
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
    text,
  };
  if (latest !== undefined) value.latest = latest;
  return value;
}

function chatState(store, sessionId = "agent-1") {
  return {
    output: store.get(chat.outputBufferFamily(sessionId)),
    outputAnsi: store.get(chat.outputAnsiFamily(sessionId)),
    outputAvailable: store.get(chat.outputAvailableFamily(sessionId)),
    transcript: store.get(chat.transcriptFamily(sessionId)),
    transcriptIds: store.get(chat.transcriptFamily(sessionId)).map((item) => item.id),
    transcriptStartLine: store.get(chat.transcriptStartLineFamily(sessionId)) ?? null,
    activity: store.get(chat.activityFamily(sessionId)) ?? null,
    activityText: store.get(chat.activityTextFamily(sessionId)),
    lastError: store.get(chat.lastErrorFamily(sessionId)),
  };
}

function applyChatAction(store, action) {
  switch (action.kind) {
    case "setNow":
      now = Date.parse(action.value);
      return;
    case "advanceMs":
      now += action.value;
      return;
    case "ingestEvent":
      store.set(chat.ingestEventAtom, action.value);
      return;
    case "snapshot":
      store.set(chat.applyOutputSnapshotAtom, action.value);
      return;
    case "markInterrupted":
      store.set(chat.markOutputInterruptedAtom, action.sessionId);
      return;
    case "clearInterruptHold":
      store.set(chat.clearLocalInterruptHoldAtom, action.sessionId);
      return;
    default:
      throw new Error(`unknown chat action ${action.kind}`);
  }
}

function runChat(input) {
  now = fixedNow;
  const store = createStore();
  for (const action of input.actions) applyChatAction(store, action);
  return chatState(store, input.sessionId ?? "agent-1");
}

function runProjectList(input) {
  switch (input.api) {
    case "reconcileProjectList": {
      const previous = input.previous.map(project);
      const incoming = input.incoming.map(project);
      const next = projects.reconcileProjectList(previous, incoming);
      return {
        sameReference: next === previous,
        ids: next.map((entry) => entry.id),
        names: next.map((entry) => entry.name),
        paths: next.map((entry) => entry.path),
      };
    }
    case "reconcileProjectsAtom": {
      now = fixedNow;
      const store = createStore();
      store.set(projects.projectsAtom, input.seed.projects.map(project));
      store.set(projects.selectedProjectPathAtom, input.seed.selectedProjectPath);
      store.set(projects.selectedSessionIdAtom, input.seed.selectedSessionId);
      if (input.seed.explicitProjectSelection) {
        store.set(projects.explicitProjectSelectionAtom, input.seed.explicitProjectSelection);
      }
      store.set(projects.reconcileProjectsAtom, input.incoming.map(project));
      return {
        projectPaths: store.get(projects.projectsAtom).map((entry) => entry.path),
        selectedProjectPath: store.get(projects.selectedProjectPathAtom),
        selectedSessionId: store.get(projects.selectedSessionIdAtom),
        lastSyncAt: store.get(projects.lastSyncAtAtom),
      };
    }
    case "selectProjectAtom": {
      now = fixedNow;
      const store = createStore();
      store.set(projects.selectProjectAtom, input.projectPath);
      const explicit = store.get(projects.explicitProjectSelectionAtom);
      return {
        selectedProjectPath: store.get(projects.selectedProjectPathAtom),
        selectedSessionId: store.get(projects.selectedSessionIdAtom),
        explicitProjectSelection: explicit,
        explicitHoldMs: explicit ? explicit.expiresAt - now : null,
      };
    }
    case "rememberProjectViewPath":
      for (const call of input.calls) projects.rememberProjectViewPath(call.projectPath, call.viewPath);
      return input.lookups.map((projectPath) => projects.rememberedProjectViewPath(projectPath));
    default:
      throw new Error(`unknown project-list api ${input.api}`);
  }
}

function runResourceTracker(input) {
  const tracker = trackerModule.createProjectResourceRequestTracker(input.initialScope);
  const markers = {};
  const current = {};
  const scopeTokens = new Map();
  const requestSequenceTokens = new Map();
  let nextScopeToken = 1;
  let nextRequestSequenceToken = 1;
  const normalizeRequestKey = (key) =>
    key.replace(
      /^([^\0]*\0[^\0]*\0\d+\0)([^\0]+)\0(\d+)$/,
      (_match, prefix, scope, requestSequence) => {
        if (!scopeTokens.has(scope)) scopeTokens.set(scope, `<scope:${nextScopeToken++}>`);
        if (!requestSequenceTokens.has(requestSequence)) {
          requestSequenceTokens.set(requestSequence, `<request-seq:${nextRequestSequenceToken++}>`);
        }
        return `${prefix}${scopeTokens.get(scope)}\0${requestSequenceTokens.get(requestSequence)}`;
      },
    );
  for (const action of input.actions) {
    switch (action.kind) {
      case "begin":
        markers[action.as] = tracker.begin();
        markers[action.as].requestKey = normalizeRequestKey(markers[action.as].requestKey);
        break;
      case "update":
        tracker.update(action.scope);
        break;
      case "invalidate":
        tracker.invalidate();
        break;
      case "invalidateGeneration":
        tracker.invalidateGeneration();
        break;
      case "isCurrent":
        current[action.marker] = tracker.isCurrent(markers[action.marker]);
        break;
      default:
        throw new Error(`unknown tracker action ${action.kind}`);
    }
  }
  return { markers, current };
}

function runUi(input) {
  const store = createStore();
  return {
    sidebarOpen: store.get(ui.sidebarOpenAtom),
    sidebarMode: store.get(ui.sidebarModeAtom),
    sidebarShowProjectPicker: store.get(ui.sidebarShowProjectPickerAtom),
    sidebarProjectPickerShowAll: store.get(ui.sidebarProjectPickerShowAllAtom),
  };
}

const baseMessage = message("assistant:abc123", "Published events: 21");
const chatInputs = [
  {
    name: "applies live-pane snapshots to the same state used by event streaming",
    source: "app/stores/chat.test.ts",
    actions: [
      { kind: "ingestEvent", value: { type: "error", sessionId: "agent-1", error: "stream lost" } },
      {
        kind: "snapshot",
        value: { sessionId: "agent-1", output: "hello", outputAnsi: undefined, messages: [] },
      },
    ],
  },
  {
    name: "keeps a local interrupt visible through stale running snapshots",
    source: "app/stores/chat.test.ts",
    actions: [
      { kind: "markInterrupted", sessionId: "agent-1" },
      {
        kind: "snapshot",
        value: {
          sessionId: "agent-1",
          outputAnsi: undefined,
          activity: "running",
          activityText: "Working...",
        },
      },
    ],
  },
  {
    name: "keeps a local interrupt visible through full snapshots that omit activity",
    source: "app/stores/chat.test.ts",
    actions: [
      { kind: "markInterrupted", sessionId: "agent-1" },
      {
        kind: "snapshot",
        value: { sessionId: "agent-1", output: "stale output", outputAnsi: undefined },
      },
    ],
  },
  {
    name: "accepts explicit non-running state during the local interrupt hold",
    source: "app/stores/chat.test.ts",
    actions: [
      { kind: "markInterrupted", sessionId: "agent-1" },
      {
        kind: "snapshot",
        value: { sessionId: "agent-1", outputAnsi: undefined, activity: "done", activityText: "" },
      },
    ],
  },
  {
    name: "accepts running snapshots after the local interrupt hold is cleared",
    source: "app/stores/chat.test.ts",
    actions: [
      { kind: "markInterrupted", sessionId: "agent-1" },
      { kind: "clearInterruptHold", sessionId: "agent-1" },
      {
        kind: "snapshot",
        value: {
          sessionId: "agent-1",
          outputAnsi: undefined,
          activity: "running",
          activityText: "Working...",
        },
      },
    ],
  },
  {
    name: "accepts running snapshots after the local interrupt hold expires",
    source: "app/stores/chat.test.ts",
    actions: [
      { kind: "markInterrupted", sessionId: "agent-1" },
      { kind: "advanceMs", value: 5001 },
      {
        kind: "snapshot",
        value: {
          sessionId: "agent-1",
          outputAnsi: undefined,
          activity: "running",
          activityText: "Working...",
        },
      },
    ],
  },
  {
    name: "takes the messages the service projected",
    source: "app/stores/chat.test.ts",
    actions: [
      {
        kind: "snapshot",
        value: {
          sessionId: "agent-1",
          output: "Published events: 21",
          outputAnsi: undefined,
          messages: [baseMessage],
        },
      },
    ],
  },
  {
    name: "empties rather than going stale when a snapshot carries none",
    source: "app/stores/chat.test.ts",
    actions: [
      {
        kind: "snapshot",
        value: {
          sessionId: "agent-1",
          output: "one",
          outputAnsi: undefined,
          messages: [baseMessage],
        },
      },
      { kind: "snapshot", value: { sessionId: "agent-1", output: "two", outputAnsi: undefined } },
    ],
  },
  {
    name: "keeps the coloured pane when the service sends one",
    source: "app/stores/chat.test.ts",
    actions: [
      {
        kind: "snapshot",
        value: { sessionId: "agent-1", output: "plain", outputAnsi: "\u001b[31mplain" },
      },
    ],
  },
  {
    name: "falls back to the uncoloured pane against a service too old to send one",
    source: "app/stores/chat.test.ts",
    actions: [
      { kind: "snapshot", value: { sessionId: "agent-1", output: "plain", outputAnsi: undefined } },
    ],
  },
  {
    name: "does not clear terminal buffers when a chat-only snapshot omits output",
    source: "app/stores/chat.test.ts",
    actions: [
      {
        kind: "snapshot",
        value: { sessionId: "agent-1", output: "plain", outputAnsi: "\u001b[32mplain" },
      },
      {
        kind: "snapshot",
        value: { sessionId: "agent-1", outputAnsi: undefined, messages: [baseMessage] },
      },
    ],
  },
  {
    name: "takes transcript messages from a stream event too",
    source: "app/stores/chat.test.ts",
    actions: [
      {
        kind: "ingestEvent",
        value: {
          type: "agent_output",
          sessionId: "agent-1",
          output: "Published events: 21",
          outputAnsi: "\u001b[32mPublished events: 21",
          startLine: -120,
          messages: [baseMessage],
        },
      },
    ],
  },
  {
    name: "does not clear terminal buffers when a chat-only stream event omits output",
    source: "app/stores/chat.test.ts",
    actions: [
      {
        kind: "ingestEvent",
        value: {
          type: "agent_output",
          sessionId: "agent-1",
          output: "plain",
          outputAnsi: "\u001b[32mplain",
          startLine: -120,
        },
      },
      {
        kind: "ingestEvent",
        value: {
          type: "agent_output",
          sessionId: "agent-1",
          startLine: -120,
          messages: [baseMessage],
        },
      },
    ],
  },
  {
    name: "records terminal availability from a chat-only stream event",
    source: "app/stores/chat.test.ts",
    actions: [
      {
        kind: "ingestEvent",
        value: {
          type: "agent_output",
          sessionId: "agent-1",
          startLine: -120,
          outputAvailable: true,
          messages: [baseMessage],
        },
      },
    ],
  },
  {
    name: "keeps activity text when a sparse stream event omits it",
    source: "app/stores/chat.test.ts",
    actions: [
      {
        kind: "ingestEvent",
        value: {
          type: "agent_output",
          sessionId: "agent-1",
          output: "work",
          outputAnsi: undefined,
          startLine: -120,
          activity: "running",
          activityText: "Working... (3s)",
        },
      },
      {
        kind: "ingestEvent",
        value: {
          type: "agent_output",
          sessionId: "agent-1",
          startLine: -120,
          messages: [baseMessage],
        },
      },
    ],
  },
  {
    name: "clears activity text when a stream event explicitly sends empty text",
    source: "app/stores/chat.test.ts",
    actions: [
      {
        kind: "ingestEvent",
        value: {
          type: "agent_output",
          sessionId: "agent-1",
          output: "work",
          outputAnsi: undefined,
          startLine: -120,
          activity: "running",
          activityText: "Working... (3s)",
        },
      },
      {
        kind: "ingestEvent",
        value: {
          type: "agent_output",
          sessionId: "agent-1",
          startLine: -120,
          activityText: "",
        },
      },
    ],
  },
  {
    name: "keeps an expanded transcript window when a smaller snapshot arrives",
    source: "app/stores/chat.test.ts",
    actions: [
      {
        kind: "snapshot",
        value: {
          sessionId: "agent-1",
          outputAnsi: undefined,
          outputAvailable: true,
          startLine: -640,
          messages: [
            message("assistant:older", "older message", undefined),
            message("assistant:newer", "newer message"),
          ],
        },
      },
      {
        kind: "snapshot",
        value: {
          sessionId: "agent-1",
          outputAnsi: undefined,
          outputAvailable: true,
          startLine: -160,
          messages: [
            message("assistant:newer", "newer message"),
            message("assistant:newest", "newest message"),
          ],
        },
      },
    ],
  },
  {
    name: "merges smaller windows by sequence overlap when repeated-message ids shift",
    source: "app/stores/chat.test.ts",
    actions: [
      {
        kind: "snapshot",
        value: {
          sessionId: "agent-1",
          outputAnsi: undefined,
          outputAvailable: true,
          startLine: -640,
          messages: [message("assistant:same", "same", undefined), message("assistant:same#2", "same")],
        },
      },
      {
        kind: "snapshot",
        value: {
          sessionId: "agent-1",
          outputAnsi: undefined,
          outputAvailable: true,
          startLine: -160,
          messages: [message("assistant:same", "same"), message("assistant:newest", "newest")],
        },
      },
    ],
  },
  {
    name: "replaces the transcript when a wider stream event arrives",
    source: "app/stores/chat.test.ts",
    actions: [
      {
        kind: "ingestEvent",
        value: {
          type: "agent_output",
          sessionId: "agent-1",
          startLine: -160,
          messages: [message("assistant:tail", "tail")],
        },
      },
      {
        kind: "ingestEvent",
        value: {
          type: "agent_output",
          sessionId: "agent-1",
          startLine: -640,
          messages: [message("assistant:wider", "wider")],
        },
      },
    ],
  },
  {
    name: "clears stale activity text when a snapshot explicitly sends an empty label",
    source: "app/stores/chat.test.ts",
    actions: [
      {
        kind: "snapshot",
        value: {
          sessionId: "agent-1",
          outputAnsi: undefined,
          activity: "running",
          activityText: "Perambulating...",
        },
      },
      {
        kind: "snapshot",
        value: {
          sessionId: "agent-1",
          outputAnsi: undefined,
          activity: "interrupted",
          activityText: "",
        },
      },
    ],
  },
];

const projectListInputs = [
  {
    name: "preserves the previous array when the daemon snapshot is unchanged",
    source: "app/stores/projects.test.ts",
    api: "reconcileProjectList",
    previous: [{ id: "b", name: "Beta", path: "/repo/b" }],
    incoming: [{ id: "b", name: "Beta", path: "/repo/b" }],
  },
  {
    name: "returns a sorted replacement when project content changes",
    source: "app/stores/projects.test.ts",
    api: "reconcileProjectList",
    previous: [{ id: "b", name: "Beta", path: "/repo/b" }],
    incoming: [
      { id: "b", name: "Beta", path: "/repo/b" },
      { id: "a", name: "Alpha", path: "/repo/a" },
    ],
  },
  {
    name: "sorts duplicate project names by stable project identity",
    source: "app/stores/projects.test.ts",
    api: "reconcileProjectList",
    previous: [],
    incoming: [
      { id: "z", name: "Same", path: "/repo/z" },
      { id: "a", name: "Same", path: "/repo/a" },
      { id: "b", name: "Same", path: "/repo/a" },
    ],
  },
  {
    name: "keeps the selected project during transient empty discovery snapshots",
    source: "app/stores/projects.test.ts",
    api: "reconcileProjectsAtom",
    seed: {
      projects: [
        { id: "tealstreet-next", name: "Tealstreet", path: "/tealstreet-next" },
        { id: "thegrand", name: "The Grand", path: "/thegrand" },
      ],
      selectedProjectPath: "/thegrand",
      selectedSessionId: "claude-1",
      explicitProjectSelection: { path: "/thegrand", expiresAt: fixedNow + 1000 },
    },
    incoming: [],
  },
  {
    name: "clears stale selection when discovery really becomes empty",
    source: "app/stores/projects.test.ts",
    api: "reconcileProjectsAtom",
    seed: {
      projects: [{ id: "tealstreet-next", name: "Tealstreet", path: "/tealstreet-next" }],
      selectedProjectPath: "/tealstreet-next",
      selectedSessionId: "claude-1",
    },
    incoming: [],
  },
  {
    name: "records a short explicit-selection guard when the user picks a project",
    source: "app/stores/projects.test.ts",
    api: "selectProjectAtom",
    projectPath: "/thegrand",
  },
  {
    name: "keeps per-project view memory in process only",
    source: "app/stores/projects.test.ts",
    api: "rememberProjectViewPath",
    calls: [
      { projectPath: "/thegrand", viewPath: "/agent/claude-1/chat?project=%2Fthegrand" },
      { projectPath: "/aimux", viewPath: "/project?project=%2Faimux&section=queue" },
    ],
    lookups: ["/thegrand", "/aimux", "/missing"],
  },
];

const trackerInputs = [
  {
    name: "rejects responses from a previous project or endpoint generation",
    source: "app/lib/project-resource-request-tracker.test.ts",
    initialScope: { projectPath: "/repo-a", endpointKey: "127.0.0.1:43190" },
    actions: [
      { kind: "begin", as: "oldRequest" },
      { kind: "update", scope: { projectPath: "/repo-b", endpointKey: "127.0.0.1:43191" } },
      { kind: "begin", as: "currentRequest" },
      { kind: "isCurrent", marker: "oldRequest" },
      { kind: "isCurrent", marker: "currentRequest" },
    ],
  },
  {
    name: "invalidates an in-flight refresh when a mutation changes the cached resource",
    source: "app/lib/project-resource-request-tracker.test.ts",
    initialScope: { projectPath: "/repo", endpointKey: "127.0.0.1:43190" },
    actions: [
      { kind: "begin", as: "listBeforeMutation" },
      { kind: "invalidate" },
      { kind: "begin", as: "listAfterMutation" },
      { kind: "isCurrent", marker: "listBeforeMutation" },
      { kind: "isCurrent", marker: "listAfterMutation" },
    ],
  },
  {
    name: "invalidates in-flight work on unmount without changing project identity",
    source: "app/lib/project-resource-request-tracker.test.ts",
    initialScope: { projectPath: "/repo", endpointKey: "127.0.0.1:43190" },
    actions: [
      { kind: "begin", as: "inFlight" },
      { kind: "invalidateGeneration" },
      { kind: "isCurrent", marker: "inFlight" },
    ],
  },
];

const uiInputs = [
  {
    name: "defaults project sidebar and project picker state",
    source: "app/stores/ui.test.ts",
    api: "uiDefaults",
  },
];

function casesFor(prefix, inputs, run) {
  return inputs.map((input, index) => ({
    id: `${prefix}-${String(index + 1).padStart(3, "0")}`,
    name: input.name,
    source: input.source,
    api: input.api ?? prefix,
    input,
    output: run(input),
    inputSha256: hash(input),
  }));
}

try {
  await writeContractJson(OUTPUTS.chat, {
    version: 1,
    source: ["app/stores/chat.test.ts", "app/stores/chat.ts"],
    generatedBy: "scripts/capture-app-store-runtime-contract.mjs",
    description:
      "App chat output store snapshots, stream events, local interrupt hold, terminal colour fallback, activity text, and transcript window merge behavior captured by running the TypeScript Jotai store.",
    cases: casesFor("app-state-chat-output", chatInputs, runChat),
  });

  await writeContractJson(OUTPUTS.projects, {
    version: 1,
    source: ["app/stores/projects.test.ts", "app/stores/projects.ts"],
    generatedBy: "scripts/capture-app-store-runtime-contract.mjs",
    description:
      "App daemon project list reconciliation, selected-project retention, explicit selection guard, and per-project view memory captured by running the TypeScript Jotai project store.",
    cases: casesFor("app-state-project-list", projectListInputs, runProjectList),
  });

  await writeContractJson(OUTPUTS.resourceTracker, {
    version: 1,
    source: [
      "app/lib/project-resource-request-tracker.test.ts",
      "app/lib/project-resource-request-tracker.ts",
    ],
    generatedBy: "scripts/capture-app-store-runtime-contract.mjs",
    description:
      "App project resource request tracker sequence and endpoint-generation invalidation behavior captured by running the TypeScript tracker.",
    cases: casesFor("app-state-resource-request-tracker", trackerInputs, runResourceTracker),
  });

  await writeContractJson(OUTPUTS.ui, {
    version: 1,
    source: ["app/stores/ui.test.ts", "app/stores/ui.ts"],
    generatedBy: "scripts/capture-app-store-runtime-contract.mjs",
    description: "App ephemeral sidebar UI store defaults captured by running the TypeScript Jotai UI store.",
    cases: casesFor("app-state-ui-defaults", uiInputs, runUi),
  });
} finally {
  Date.now = originalDateNow;
}

for (const [name, url] of Object.entries(OUTPUTS)) {
  const parsed = JSON.parse(await readFile(url, "utf8"));
  console.log(`${url.pathname}: ${parsed.cases.length} ${name} cases`);
}
