#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import ts from "typescript";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/app-state/helpers.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

async function importTypeScriptModule(path, stripImports = false) {
  const url = new URL(path, ROOT);
  let source = await readFile(url, "utf8");
  if (stripImports) source = source.replace(/^import .*;\n/gm, "");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: url.pathname,
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);
}

const chatLoading = await importTypeScriptModule("app/lib/chat-loading.ts");
const sharedSessions = await importTypeScriptModule("app/lib/shared-sessions.ts", true);

function run(input) {
  switch (input.api) {
    case "paneOutputSnapshotHasVisibleTranscript":
      return chatLoading.paneOutputSnapshotHasVisibleTranscript(input.value);
    case "shouldForceNativePinnedChatOffset":
      return chatLoading.shouldForceNativePinnedChatOffset(input.value);
    case "shouldHydrateTerminalOutput":
      return chatLoading.shouldHydrateTerminalOutput(input.value);
    case "agentOutputModeForVisiblePane":
      return chatLoading.agentOutputModeForVisiblePane(input.value);
    case "activeSessionsFromShareSummaries":
      return sharedSessions.activeSessionsFromShareSummaries(input.shares);
    case "sharedSessionsEqual":
      return sharedSessions.sharedSessionsEqual(input.left, input.right);
    case "mergeActiveSharedSessions":
      return sharedSessions.mergeActiveSharedSessions(input.shares, input.activeShare);
    case "shouldApplySharedSessionHydrate":
      return sharedSessions.shouldApplySharedSessionHydrate(input.current, input.next, input.options);
    default:
      throw new Error(`unknown api ${input.api}`);
  }
}

const share = {
  shareId: "share-1",
  ownerUserId: "owner-1",
  projectRoot: "/repo",
  sessionId: "claude-1",
  serviceEndpoint: { host: "127.0.0.1", port: 43192 },
  acceptedAt: "2026-08-02T00:00:00.000Z",
};

const olderShare = {
  shareId: "share-old",
  ownerUserId: "owner-1",
  projectRoot: "/repo-old",
  sessionId: "claude-old",
  serviceEndpoint: { host: "127.0.0.1", port: 43192 },
  acceptedAt: "2026-08-01T00:00:00.000Z",
};

const activeShare = {
  shareId: "share-active",
  ownerUserId: "owner-1",
  projectRoot: "/repo-active",
  sessionId: "claude-active",
  serviceEndpoint: { host: "127.0.0.1", port: 43192 },
  acceptedAt: "2026-08-03T00:00:00.000Z",
};

const inputs = [
  {
    name: "keeps initial transcript loader visible for fast empty snapshots",
    source: "app/lib/chat-loading.test.ts",
    api: "paneOutputSnapshotHasVisibleTranscript",
    value: { messages: [], output: "", outputAnsi: "" },
  },
  {
    name: "treats projected messages as visible transcript content",
    source: "app/lib/chat-loading.test.ts",
    api: "paneOutputSnapshotHasVisibleTranscript",
    value: { messages: [{ id: "m1" }] },
  },
  {
    name: "treats plain terminal bytes as visible transcript content",
    source: "app/lib/chat-loading.test.ts",
    api: "paneOutputSnapshotHasVisibleTranscript",
    value: { messages: [], output: "ready" },
  },
  {
    name: "treats ANSI terminal bytes as visible transcript content",
    source: "app/lib/chat-loading.test.ts",
    api: "paneOutputSnapshotHasVisibleTranscript",
    value: { messages: [], outputAnsi: "\u001b[32mok" },
  },
  {
    name: "treats output availability as visible transcript content",
    source: "app/lib/chat-loading.test.ts",
    api: "paneOutputSnapshotHasVisibleTranscript",
    value: { messages: [], outputAvailable: true },
  },
  {
    name: "does not override native keyboard-controller offsets while visible",
    source: "app/lib/chat-loading.test.ts",
    api: "shouldForceNativePinnedChatOffset",
    value: { keyboardVisible: true, pinnedToEnd: true },
  },
  {
    name: "keeps native chat pinned when the keyboard is closed",
    source: "app/lib/chat-loading.test.ts",
    api: "shouldForceNativePinnedChatOffset",
    value: { keyboardVisible: false, pinnedToEnd: true },
  },
  {
    name: "does not force native pinned offset when chat is not pinned",
    source: "app/lib/chat-loading.test.ts",
    api: "shouldForceNativePinnedChatOffset",
    value: { keyboardVisible: false, pinnedToEnd: false },
  },
  {
    name: "hydrates terminal mode whenever terminal output is available",
    source: "app/lib/chat-loading.test.ts",
    api: "shouldHydrateTerminalOutput",
    value: { outputAvailable: true, terminalViewVisible: true },
  },
  {
    name: "does not hydrate unavailable terminal output",
    source: "app/lib/chat-loading.test.ts",
    api: "shouldHydrateTerminalOutput",
    value: { outputAvailable: false, terminalViewVisible: true },
  },
  {
    name: "does not hydrate while terminal mode is hidden",
    source: "app/lib/chat-loading.test.ts",
    api: "shouldHydrateTerminalOutput",
    value: { outputAvailable: true, terminalViewVisible: false },
  },
  {
    name: "uses full output while terminal or split mode is visible",
    source: "app/lib/chat-loading.test.ts",
    api: "agentOutputModeForVisiblePane",
    value: { terminalViewVisible: true },
  },
  {
    name: "uses projected chat output while terminal mode is hidden",
    source: "app/lib/chat-loading.test.ts",
    api: "agentOutputModeForVisiblePane",
    value: { terminalViewVisible: false },
  },
  {
    name: "maps relay summaries with service endpoints into active shared sessions",
    source: "app/lib/shared-sessions.test.ts",
    api: "activeSessionsFromShareSummaries",
    shares: [
      {
        id: "share-1",
        ownerUserId: "owner-1",
        projectRoot: "/repo",
        sessionId: "claude-1",
        serviceEndpoint: { host: "127.0.0.1", port: 43192 },
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:00.000Z",
        version: 1,
        mode: "multi",
        participants: [],
        invites: [],
      },
      {
        id: "share-2",
        ownerUserId: "owner-1",
        projectRoot: "/repo",
        sessionId: "claude-2",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:00.000Z",
        version: 1,
        mode: "multi",
        participants: [],
        invites: [],
      },
    ],
  },
  {
    name: "compares active shared sessions by value",
    source: "app/lib/shared-sessions.test.ts",
    api: "sharedSessionsEqual",
    left: [share],
    right: [{ ...share, serviceEndpoint: { ...share.serviceEndpoint } }],
  },
  {
    name: "detects active shared session accepted-at changes",
    source: "app/lib/shared-sessions.test.ts",
    api: "sharedSessionsEqual",
    left: [share],
    right: [{ ...share, acceptedAt: "2026-08-03T00:00:00.000Z" }],
  },
  {
    name: "merges an active shared session into displayed rows",
    source: "app/lib/shared-sessions.test.ts",
    api: "mergeActiveSharedSessions",
    shares: [olderShare],
    activeShare,
  },
  {
    name: "dedupes active shared session merges by owner and share id",
    source: "app/lib/shared-sessions.test.ts",
    api: "mergeActiveSharedSessions",
    shares: [activeShare],
    activeShare: { ...activeShare },
  },
  {
    name: "can keep cached shares for one transient empty hydrate",
    source: "app/lib/shared-sessions.test.ts",
    api: "shouldApplySharedSessionHydrate",
    current: [share],
    next: [],
    options: { preserveEmptyOnce: true },
  },
  {
    name: "applies empty hydrate without preserve option",
    source: "app/lib/shared-sessions.test.ts",
    api: "shouldApplySharedSessionHydrate",
    current: [share],
    next: [],
  },
  {
    name: "applies empty hydrate when current shares are empty",
    source: "app/lib/shared-sessions.test.ts",
    api: "shouldApplySharedSessionHydrate",
    current: [],
    next: [],
  },
  {
    name: "applies non-empty shared session hydrate",
    source: "app/lib/shared-sessions.test.ts",
    api: "shouldApplySharedSessionHydrate",
    current: [share],
    next: [share],
  },
];

const cases = inputs.map((input, index) => ({
  id: `app-state-helpers-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: input.source,
  api: input.api,
  input,
  output: run(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: ["app/lib/chat-loading.test.ts", "app/lib/shared-sessions.test.ts"],
  generatedBy: "scripts/capture-app-state-helpers-contract.mjs",
  description:
    "App chat loading visibility and active shared-session mapping, equality, merge, and hydrate contracts captured by running TypeScript app state helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
