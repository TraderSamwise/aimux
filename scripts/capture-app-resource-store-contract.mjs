#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import ts from "typescript";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const TEMP_DIR = new URL("app/node_modules/.contract-capture-app-resource-store/", ROOT);
const FIXED_ISO = "2026-09-04T12:00:00.000Z";
const FIXED_NOW = Date.parse(FIXED_ISO);
const OUTPUTS = {
  coordination: new URL("testdata/contracts/v1/app-state/coordination-store.json", ROOT),
  desktopState: new URL("testdata/contracts/v1/app-state/desktop-state-store.json", ROOT),
  library: new URL("testdata/contracts/v1/app-state/library-store.json", ROOT),
  notifications: new URL("testdata/contracts/v1/app-state/notification-feed-store.json", ROOT),
  security: new URL("testdata/contracts/v1/app-state/security-store.json", ROOT),
  topology: new URL("testdata/contracts/v1/app-state/topology-store.json", ROOT),
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

function rewriteDesktopState(source) {
  return source
    .replace(/from "@\/lib\/desktop-state"/g, 'from "./desktop-state.mjs"')
    .replace(/from "@\/stores\/lifecycleTransitions"/g, 'from "./lifecycleTransitions.mjs"');
}

function rewriteSecurity(source) {
  return source.replace(
    /import \{ createSsrSafeJsonStorage \} from "@\/lib\/jotai-storage";\n/,
    [
      "const __storage = new Map();",
      "const createSsrSafeJsonStorage = () => ({",
      "  getItem: (key, initialValue) => __storage.has(key) ? __storage.get(key) : initialValue,",
      "  setItem: (key, value) => { __storage.set(key, value); },",
      "  removeItem: (key) => { __storage.delete(key); },",
      "});",
      "export const __securityStorageSnapshot = () => Object.fromEntries(__storage.entries());\n",
    ].join("\n"),
  );
}

await rm(TEMP_DIR, { force: true, recursive: true });
await mkdir(TEMP_DIR, { recursive: true });

const desktopStateLibUrl = await writeTempModule(
  "desktop-state.mjs",
  "app/lib/desktop-state.ts",
);
const lifecycleTransitionsUrl = await writeTempModule(
  "lifecycleTransitions.mjs",
  "app/stores/lifecycleTransitions.ts",
);
const coordinationUrl = await writeTempModule(
  "coordination.mjs",
  "app/stores/coordination.ts",
);
const desktopStateUrl = await writeTempModule(
  "desktopState.mjs",
  "app/stores/desktopState.ts",
  rewriteDesktopState,
);
const libraryUrl = await writeTempModule("library.mjs", "app/stores/library.ts");
const notificationsUrl = await writeTempModule(
  "notifications.mjs",
  "app/stores/notifications.ts",
);
const securityUrl = await writeTempModule("security.mjs", "app/stores/security.ts", rewriteSecurity);
const topologyUrl = await writeTempModule("topology.mjs", "app/stores/topology.ts");

const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [FIXED_NOW]));
  }
  static now() {
    return FIXED_NOW;
  }
}
globalThis.Date = FixedDate;

const { createStore } = await import(new URL("app/node_modules/jotai/esm/vanilla.mjs", ROOT));
const desktopLib = await import(desktopStateLibUrl);
await import(lifecycleTransitionsUrl);
const modules = {
  coordination: await import(coordinationUrl),
  desktopState: await import(desktopStateUrl),
  library: await import(libraryUrl),
  notifications: await import(notificationsUrl),
  security: await import(securityUrl),
  topology: await import(topologyUrl),
};

function item(key) {
  return {
    key,
    kind: "notification",
    type: "msg",
    bucket: "awake",
    title: "Needs input",
    urgency: 10,
    reachability: "live",
    actionable: true,
    stale: false,
    sessionId: "agent-1",
  };
}

function worklist(overrides = {}) {
  return { items: [item("notice-1")], fetchedAt: "2026-01-01T00:00:00.000Z", ...overrides };
}

function document(id) {
  return {
    id,
    title: "AGENTS.md",
    path: "/repo/AGENTS.md",
    kind: "agents",
    size: 1200,
    updatedAt: "2026-01-01T00:00:00.000Z",
    content: "instructions",
  };
}

function library(overrides = {}) {
  return { documents: [document("doc-1")], fetchedAt: "2026-01-01T00:00:00.000Z", ...overrides };
}

function notification(id) {
  return {
    id,
    title: "Needs input",
    body: "Agent is waiting",
    sessionId: "agent-1",
    projectRoot: "/repo",
    unread: true,
    cleared: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function feed(overrides = {}) {
  return {
    notifications: [notification("notice-1")],
    unreadCount: 1,
    fetchedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function topology(overrides = {}) {
  return {
    projectName: "repo",
    health: "idle",
    counts: { worktrees: 1, agents: 1, services: 0 },
    worktrees: [
      {
        name: "Main Checkout",
        path: "/repo",
        branch: "main",
        health: "idle",
        agents: 1,
        services: 0,
      },
    ],
    rows: [
      {
        kind: "agent",
        depth: 1,
        label: "claude",
        health: "idle",
        status: "ready",
        sessionId: "agent-1",
      },
    ],
    fetchedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function desktopState(overrides = {}) {
  return { ok: true, sessions: [], services: [], worktrees: [], ...overrides };
}

function securityEvent(id) {
  return {
    id,
    kind: "new_client_detected",
    title: "New remote client detected",
    body: "Safari from SG",
    createdAt: "2026-05-24T00:00:00.000Z",
  };
}

const resourceConfigs = {
  coordination: {
    mod: modules.coordination,
    resourceFamily: "coordinationWorklistResourceFamily",
    valueFamily: "coordinationWorklistFamily",
    errorFamily: "coordinationWorklistErrorFamily",
    beginAtom: "beginCoordinationWorklistRefreshAtom",
    successAtom: "applyCoordinationWorklistSuccessAtom",
    failureAtom: "applyCoordinationWorklistFailureAtom",
    clearAtom: "clearCoordinationWorklistResourceAtom",
    requestFn: "isCurrentCoordinationWorklistRequest",
    valueField: "worklist",
  },
  desktopState: {
    mod: modules.desktopState,
    resourceFamily: "desktopStateResourceFamily",
    valueFamily: "desktopStateFamily",
    errorFamily: "desktopStateErrorFamily",
    beginAtom: "beginDesktopStateRefreshAtom",
    successAtom: "applyDesktopStateSuccessAtom",
    failureAtom: "applyDesktopStateFailureAtom",
    clearAtom: "clearDesktopStateResourceAtom",
    valueField: "state",
  },
  library: {
    mod: modules.library,
    resourceFamily: "libraryResourceFamily",
    valueFamily: "libraryFamily",
    errorFamily: "libraryErrorFamily",
    beginAtom: "beginLibraryRefreshAtom",
    successAtom: "applyLibrarySuccessAtom",
    failureAtom: "applyLibraryFailureAtom",
    clearAtom: "clearLibraryResourceAtom",
    requestFn: "isCurrentLibraryRequest",
    valueField: "library",
  },
  notifications: {
    mod: modules.notifications,
    resourceFamily: "notificationFeedResourceFamily",
    valueFamily: "notificationFeedFamily",
    errorFamily: "notificationFeedErrorFamily",
    beginAtom: "beginNotificationFeedRefreshAtom",
    successAtom: "applyNotificationFeedSuccessAtom",
    failureAtom: "applyNotificationFeedFailureAtom",
    clearAtom: "clearNotificationFeedResourceAtom",
    unreadFamily: "notificationUnreadCountFamily",
    valueField: "feed",
  },
  topology: {
    mod: modules.topology,
    resourceFamily: "topologyResourceFamily",
    valueFamily: "topologyFamily",
    errorFamily: "topologyErrorFamily",
    beginAtom: "beginTopologyRefreshAtom",
    successAtom: "applyTopologySuccessAtom",
    failureAtom: "applyTopologyFailureAtom",
    clearAtom: "clearTopologyResourceAtom",
    settleAtom: "settleTopologyRefreshAtom",
    requestFn: "isCurrentTopologyRequest",
    valueField: "topology",
  },
};

function resourceSnapshot(store, config, projectPath) {
  const mod = config.mod;
  const output = {
    resource: store.get(mod[config.resourceFamily](projectPath)),
    value: store.get(mod[config.valueFamily](projectPath)),
    error: store.get(mod[config.errorFamily](projectPath)),
  };
  if (config.unreadFamily) output.unreadCount = store.get(mod[config.unreadFamily](projectPath));
  return output;
}

function runResourceCase(configName, input) {
  const config = resourceConfigs[configName];
  const mod = config.mod;
  const store = createStore();
  const projectPath = input.projectPath ?? "/repo";
  for (const action of input.actions) {
    if (action.kind === "success") {
      store.set(mod[config.successAtom], {
        projectPath,
        [config.valueField]: action.value,
        updatedAt: action.updatedAt,
      });
    } else if (action.kind === "begin") {
      store.set(mod[config.beginAtom], projectPath);
    } else if (action.kind === "failure") {
      store.set(mod[config.failureAtom], { projectPath, error: action.error });
    } else if (action.kind === "settle") {
      store.set(mod[config.settleAtom], projectPath);
    } else if (action.kind === "clear") {
      store.set(mod[config.clearAtom], projectPath);
    } else {
      throw new Error(`unknown resource action ${action.kind}`);
    }
  }
  const output = resourceSnapshot(store, config, projectPath);
  if (input.requestChecks) {
    output.requestChecks = input.requestChecks.map(({ request, current }) =>
      mod[config.requestFn](request, current),
    );
  }
  return output;
}

function runDesktopGrouping(input) {
  if (input.api === "groupByWorktree") return desktopLib.groupByWorktree(input.state);
  if (input.api === "activeWorktreeBuckets") {
    return desktopLib
      .groupByWorktree(input.state)
      .flatMap((bucket) => {
        const active = desktopLib.filterWorktreeBucketToActiveEntries(bucket);
        return active ? [active] : [];
      });
  }
  throw new Error(`unknown desktop grouping api ${input.api}`);
}

function runSecurity(input) {
  const store = createStore();
  const mod = modules.security;
  for (const action of input.actions) {
    if (action.kind === "add") store.set(mod.addSecurityEventAtom, action.event);
    else if (action.kind === "markRead") store.set(mod.markSecurityEventsReadAtom);
    else if (action.kind === "clear") store.set(mod.clearSecurityEventsAtom);
    else throw new Error(`unknown security action ${action.kind}`);
  }
  return {
    events: store.get(mod.securityEventsAtom),
    unreadCount: store.get(mod.securityUnreadCountAtom),
    storage: mod.__securityStorageSnapshot(),
  };
}

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

const lifecycleCases = (source, currentValue, recoveredValue, requestChecks = true) => [
  {
    name: "marks an in-flight refresh stale when a previous value exists",
    source,
    actions: [
      { kind: "success", value: currentValue, updatedAt: 10 },
      { kind: "begin" },
    ],
  },
  {
    name: "keeps the last good value after a refresh failure",
    source,
    actions: [
      { kind: "success", value: currentValue, updatedAt: 10 },
      { kind: "failure", error: "service unavailable" },
    ],
  },
  {
    name: "clears stale/error metadata after the resource recovers",
    source,
    actions: [
      { kind: "success", value: currentValue, updatedAt: 10 },
      { kind: "failure", error: "service unavailable" },
      { kind: "success", value: recoveredValue, updatedAt: 20 },
    ],
  },
  {
    name: "clears the resource when the project service endpoint disappears",
    source,
    actions: [
      { kind: "success", value: currentValue, updatedAt: 10 },
      { kind: "clear" },
    ],
  },
  ...(requestChecks
    ? [
        {
          name: "rejects in-flight results from an old endpoint generation",
          source,
          actions: [],
          requestChecks: [
            {
              request: { projectPath: "/repo", endpointKey: "127.0.0.1:43190", generation: 1 },
              current: { projectPath: "/repo", endpointKey: "127.0.0.1:43191", generation: 2 },
            },
            {
              request: { projectPath: "/repo", endpointKey: "127.0.0.1:43191", generation: 2 },
              current: { projectPath: "/repo", endpointKey: "127.0.0.1:43191", generation: 2 },
            },
          ],
        },
      ]
    : []),
];

const desktopGroupingInputs = [
  {
    name: "uses server-composed worktree groups instead of regrouping raw sessions",
    source: "app/stores/desktopState.test.ts",
    api: "groupByWorktree",
    state: desktopState({
      mainCheckoutInfo: { name: "repo", branch: "main" },
      mainCheckoutPath: "/repo",
      sessions: [
        { id: "raw-extra", status: "running", toolConfigKey: "codex" },
        { id: "canonical", status: "running", toolConfigKey: "claude" },
      ],
      worktreeGroups: [
        {
          name: "Main Checkout",
          branch: "main",
          status: "active",
          sessions: [{ id: "canonical", status: "running", toolConfigKey: "claude" }],
          services: [],
        },
      ],
    }),
  },
  {
    name: "keeps overseer sessions out of legacy client-side worktree grouping",
    source: "app/stores/desktopState.test.ts",
    api: "groupByWorktree",
    state: desktopState({
      sessions: [
        { id: "overseer-flag", status: "running", toolConfigKey: "codex", overseer: true },
        { id: "overseer-team", status: "running", toolConfigKey: "claude", team: { role: "overseer" } },
        { id: "agent", status: "running", toolConfigKey: "codex" },
      ],
    }),
  },
  {
    name: "preserves pending worktree flags through worktree grouping",
    source: "app/stores/desktopState.test.ts",
    api: "groupByWorktree",
    state: desktopState({
      worktrees: [
        { name: "feature", path: "/repo/.aimux/worktrees/feature", branch: "feature", pending: true },
        { name: "remove-me", path: "/repo/.aimux/worktrees/remove-me", branch: "remove-me", removing: true },
      ],
    }),
  },
  {
    name: "filters sidebar buckets to active entries like TUI hidden-offline mode",
    source: "app/stores/desktopState.test.ts",
    api: "activeWorktreeBuckets",
    state: desktopState({
      mainCheckoutInfo: { name: "Main Checkout", branch: "main" },
      mainCheckoutPath: "/repo",
      worktreeGroups: [
        {
          name: "Main Checkout",
          branch: "main",
          status: "active",
          sessions: [
            { id: "needs-live", status: "running", attention: "needs_input" },
            { id: "stale-needs", status: "offline", attention: "needs_input" },
            { id: "stopped", status: "offline" },
          ],
          services: [{ id: "dead-service", command: "dev", args: [], status: "offline" }],
        },
        {
          name: "dead",
          branch: "dead",
          path: "/repo/.aimux/worktrees/dead",
          status: "offline",
          sessions: [{ id: "only-offline", status: "offline" }],
          services: [],
        },
      ],
    }),
  },
];

const desktopResourceInputs = [
  ...lifecycleCases(
    "app/stores/desktopState.test.ts",
    desktopState(),
    desktopState({ sessions: [{ id: "agent-1", status: "running", toolConfigKey: "claude" }] }),
    false,
  ),
  {
    name: "clears stale refresh errors when retrying with a previous desktop-state",
    source: "app/stores/desktopState.test.ts",
    actions: [
      { kind: "success", value: desktopState(), updatedAt: 10 },
      { kind: "failure", error: "request timed out after 10000ms" },
      { kind: "begin" },
    ],
  },
];

const notificationInputs = [
  ...lifecycleCases(
    "app/stores/notifications.test.ts",
    feed(),
    feed({ notifications: [notification("notice-2")], unreadCount: 2 }),
    false,
  ),
  {
    name: "clears stale refresh errors when retrying with a previous feed",
    source: "app/stores/notifications.test.ts",
    actions: [
      { kind: "success", value: feed(), updatedAt: 10 },
      { kind: "failure", error: "request timed out after 10000ms" },
      { kind: "begin" },
    ],
  },
  {
    name: "derives unread count from the resource value",
    source: "app/stores/notifications.test.ts",
    actions: [{ kind: "success", value: feed({ unreadCount: 3 }), updatedAt: 10 }],
  },
];

const topologyInputs = [
  ...lifecycleCases(
    "app/stores/topology.test.ts",
    topology(),
    topology({ counts: { worktrees: 1, agents: 2, services: 0 } }),
  ),
  {
    name: "settles transient refreshes without surfacing a stale failure",
    source: "app/stores/topology.test.ts",
    actions: [
      { kind: "success", value: topology(), updatedAt: 10 },
      { kind: "begin" },
      { kind: "settle" },
    ],
  },
];

await writeContractJson(OUTPUTS.coordination, {
  version: 1,
  source: ["app/stores/coordination.test.ts", "app/stores/coordination.ts"],
  generatedBy: "scripts/capture-app-resource-store-contract.mjs",
  description:
    "App coordination worklist resource lifecycle and request-scope matching captured by running TypeScript Jotai atoms.",
  cases: casesFor("app-state-coordination-store", lifecycleCases(
    "app/stores/coordination.test.ts",
    worklist(),
    worklist({ items: [item("notice-2")] }),
  ), (input) => runResourceCase("coordination", input)),
});

await writeContractJson(OUTPUTS.desktopState, {
  version: 1,
  source: ["app/stores/desktopState.test.ts", "app/stores/desktopState.ts", "app/lib/desktop-state.ts"],
  generatedBy: "scripts/capture-app-resource-store-contract.mjs",
  description:
    "App desktop-state worktree grouping, active bucket filtering, and critical resource lifecycle captured by running TypeScript helpers and Jotai atoms.",
  cases: [
    ...casesFor("app-state-desktop-state-store", desktopGroupingInputs, runDesktopGrouping),
    ...casesFor("app-state-desktop-state-store", desktopResourceInputs, (input) =>
      runResourceCase("desktopState", input),
    ).map((entry, index) => ({ ...entry, id: `app-state-desktop-state-store-${String(index + 5).padStart(3, "0")}` })),
  ],
});

await writeContractJson(OUTPUTS.library, {
  version: 1,
  source: ["app/stores/library.test.ts", "app/stores/library.ts"],
  generatedBy: "scripts/capture-app-resource-store-contract.mjs",
  description:
    "App library resource lifecycle and request-scope matching captured by running TypeScript Jotai atoms.",
  cases: casesFor("app-state-library-store", lifecycleCases(
    "app/stores/library.test.ts",
    library(),
    library({ documents: [document("doc-2")] }),
  ), (input) => runResourceCase("library", input)),
});

await writeContractJson(OUTPUTS.notifications, {
  version: 1,
  source: ["app/stores/notifications.test.ts", "app/stores/notifications.ts"],
  generatedBy: "scripts/capture-app-resource-store-contract.mjs",
  description:
    "App notification feed resource lifecycle, retry error clearing, and unread-count derivation captured by running TypeScript Jotai atoms.",
  cases: casesFor("app-state-notification-feed-store", notificationInputs, (input) =>
    runResourceCase("notifications", input),
  ),
});

await writeContractJson(OUTPUTS.security, {
  version: 1,
  source: ["app/stores/security.test.ts", "app/stores/security.ts"],
  generatedBy: "scripts/capture-app-resource-store-contract.mjs",
  description:
    "App security inbox add, unread, mark-read, clear, and persistence-shape behavior captured by running TypeScript Jotai atoms with fixed time.",
  cases: casesFor("app-state-security-store", [
    {
      name: "tracks unread security events and persists them",
      source: "app/stores/security.test.ts",
      actions: [
        { kind: "add", event: securityEvent("sec-1") },
        { kind: "markRead" },
        { kind: "clear" },
      ],
    },
    {
      name: "preserves received/read timestamps when a duplicate event arrives",
      source: "app/stores/security.ts",
      actions: [
        { kind: "add", event: securityEvent("sec-1") },
        { kind: "markRead" },
        { kind: "add", event: { ...securityEvent("sec-1"), body: "Updated body" } },
      ],
    },
  ], runSecurity),
});

await writeContractJson(OUTPUTS.topology, {
  version: 1,
  source: ["app/stores/topology.test.ts", "app/stores/topology.ts"],
  generatedBy: "scripts/capture-app-resource-store-contract.mjs",
  description:
    "App topology resource lifecycle, transient settle behavior, and request-scope matching captured by running TypeScript Jotai atoms.",
  cases: casesFor("app-state-topology-store", topologyInputs, (input) =>
    runResourceCase("topology", input),
  ),
});

globalThis.Date = RealDate;

for (const [name, url] of Object.entries(OUTPUTS)) {
  const parsed = JSON.parse(await readFile(url, "utf8"));
  console.log(`${url.pathname}: ${parsed.cases.length} ${name} cases`);
}
