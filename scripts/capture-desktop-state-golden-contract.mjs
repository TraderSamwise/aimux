#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/dashboard/desktop-state-golden.json", ROOT);

const { initPaths } = await import(new URL("dist/paths.js", ROOT));
const { createRuntimeExchangeStore, getExchangeStoreStats, resetExchangeStoreStats } = await import(
  new URL("dist/runtime-core/exchange-store.js", ROOT)
);
const { getTopologyStoreStats, resetTopologyStoreStats } = await import(
  new URL("dist/runtime-core/topology-store.js", ROOT)
);
const { upsertTopologySession } = await import(new URL("dist/runtime-core/topology-sessions.js", ROOT));
const { appendMessage, createThread } = await import(new URL("dist/threads.js", ROOT));
const { writeTask } = await import(new URL("dist/tasks.js", ROOT));
const { getWorktreeGitCallCount, listWorktrees, resetWorktreeGitCallCount } = await import(
  new URL("dist/worktree.js", ROOT)
);
const { buildDesktopStateSnapshot } = await import(new URL("dist/multiplexer/dashboard-model.js", ROOT));

const THREAD_COUNT = 16;
const MESSAGES_PER_THREAD = 3;
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

let repoRoot;
let worktreePath;

function normalize(value) {
  const json = JSON.stringify(value);
  if (json === undefined) return value;
  return JSON.parse(json.split(worktreePath).join("<WORKTREE>").split(repoRoot).join("<REPO>"));
}

function stampDeterministicTimestamps() {
  createRuntimeExchangeStore().update((exchange) => ({
    ...exchange,
    generatedAt: "2026-01-01T00:00:00.000Z",
    threads: exchange.threads.map((thread, index) => ({
      ...thread,
      createdAt: `2026-01-01T00:${String(index).padStart(2, "0")}:00.000Z`,
      updatedAt: `2026-01-01T01:${String(index).padStart(2, "0")}:00.000Z`,
    })),
    messages: exchange.messages.map((message, index) => ({
      ...message,
      ts: `2026-01-01T02:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
    })),
    inbox: exchange.inbox.map((entry, index) => ({
      ...entry,
      updatedAt: `2026-01-01T03:${String(index % 60).padStart(2, "0")}:00.000Z`,
    })),
  }));
}

function seedExchange() {
  for (let index = 0; index < THREAD_COUNT; index++) {
    const threadId = `thread-${String(index).padStart(2, "0")}`;
    const owner = index % 3 === 0 ? "user" : `claude-${index % 2}`;
    createThread({
      id: threadId,
      title: `Thread ${index}`,
      kind: index % 4 === 0 ? "task" : "conversation",
      createdBy: "user",
      participants: ["user", `claude-${index % 2}`],
      owner,
      waitingOn: index % 2 === 0 ? ["user"] : [`claude-${index % 2}`],
      unreadBy: index % 3 === 0 ? ["user"] : undefined,
    });
    for (let messageIndex = 0; messageIndex < MESSAGES_PER_THREAD; messageIndex++) {
      appendMessage(threadId, {
        id: `${threadId}-msg-${messageIndex}`,
        from: messageIndex % 2 === 0 ? "user" : `claude-${index % 2}`,
        to: [messageIndex % 2 === 0 ? `claude-${index % 2}` : "user"],
        kind: messageIndex % 2 === 0 ? "request" : "reply",
        body: `message ${messageIndex} on thread ${index}`,
        deliveredTo: messageIndex === MESSAGES_PER_THREAD - 1 ? undefined : ["user", `claude-${index % 2}`],
      });
    }
  }

  writeTask({
    id: "task-open",
    status: "assigned",
    assignedBy: "user",
    assignedTo: "claude-0",
    threadId: "thread-00",
    description: "open task",
    prompt: "do the thing",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  writeTask({
    id: "task-blocked",
    status: "blocked",
    assignedBy: "user",
    assignedTo: "claude-1",
    threadId: "thread-04",
    description: "blocked task",
    prompt: "do the other thing",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  stampDeterministicTimestamps();
}

function seedTopology() {
  upsertTopologySession(
    {
      id: "codex-offline",
      tool: "codex",
      toolConfigKey: "codex",
      command: "codex",
      args: ["--full-auto"],
      lifecycle: "offline",
      createdAt: "2026-01-01T00:00:00.000Z",
      worktreePath,
    },
    "offline",
    { projectRoot: repoRoot, now: "2026-01-01T00:00:01.000Z" },
  );
  upsertTopologySession(
    {
      id: "codex-offline-main",
      tool: "codex",
      toolConfigKey: "codex",
      command: "codex",
      args: [],
      lifecycle: "offline",
      createdAt: "2026-01-01T00:00:02.000Z",
      worktreePath: repoRoot,
    },
    "offline",
    { projectRoot: repoRoot, now: "2026-01-01T00:00:03.000Z" },
  );
}

function buildHost() {
  return {
    projectRoot: repoRoot,
    sessions: [
      { id: "claude-0", command: "claude", status: "running", startTime: Date.parse("2026-01-01T00:00:00.000Z") },
      { id: "claude-1", command: "claude", status: "idle", startTime: Date.parse("2026-01-01T00:01:00.000Z") },
    ],
    activeIndex: 0,
    offlineSessions: [],
    offlineServices: [
      {
        id: "service-web",
        launchCommandLine: "yarn dev",
        worktreePath,
        cwd: worktreePath,
        createdAt: "2026-01-01T00:00:04.000Z",
      },
    ],
    sessionWorktreePaths: new Map([
      ["claude-0", repoRoot],
      ["claude-1", worktreePath],
    ]),
    sessionTmuxTargets: new Map(),
    sessionRoles: new Map(),
    sessionToolKeys: new Map([
      ["claude-0", "claude"],
      ["claude-1", "claude"],
    ]),
    getSessionLabel: (id) => `label-${id}`,
    deriveHeadline: (id) => `headline-${id}`,
    serviceLabelForCommand: (command) => `svc:${command}`,
    listDesktopWorktrees: () =>
      listWorktrees(repoRoot).map((worktree) => ({
        name: worktree.path === repoRoot ? "Main Checkout" : worktree.name,
        path: worktree.path,
        branch: worktree.branch,
        isBare: worktree.isBare ?? false,
        createdAt: worktree.path === repoRoot ? "2026-01-01T00:00:00.000Z" : "2026-01-01T00:00:05.000Z",
      })),
    syncSessionsFromTopology: () => undefined,
    restoreTmuxSessionsFromTopology: () => [],
    tmuxRuntimeManager: {
      listProjectManagedWindows: () => [
        {
          target: { windowId: "@1", sessionName: "aimux-golden", windowIndex: 1, windowName: "claude-0" },
          metadata: { kind: "agent", sessionId: "claude-0", createdAt: "2026-01-01T00:00:00.000Z" },
        },
        {
          target: { windowId: "@2", sessionName: "aimux-golden", windowIndex: 2, windowName: "claude-1" },
          metadata: { kind: "agent", sessionId: "claude-1", createdAt: "2026-01-01T00:01:00.000Z" },
        },
        {
          target: { windowId: "@3", sessionName: "aimux-golden", windowIndex: 3, windowName: "service-api" },
          metadata: {
            kind: "service",
            sessionId: "service-api",
            createdAt: "2026-01-01T00:02:00.000Z",
            worktreePath: repoRoot,
          },
        },
      ],
      isWindowAlive: () => true,
      displayMessage: (_format, windowId) => `node\t${windowId === "@1" ? 4242 : 4243}`,
      captureTarget: (target) => `line one\nlast line for ${target.windowId}\n`,
    },
  };
}

repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "aimux-desktop-golden-")));
try {
  execFileSync("git", ["init", "-b", "master"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot, stdio: "ignore" });
  writeFileSync(join(repoRoot, "README.md"), "golden\n");
  execFileSync("git", ["add", "-A"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "ignore" });
  worktreePath = join(repoRoot, ".aimux", "worktrees", "feature-a");
  execFileSync("git", ["worktree", "add", "-b", "feature-a", worktreePath], { cwd: repoRoot, stdio: "ignore" });

  await initPaths(repoRoot);
  seedExchange();
  seedTopology();

  const runtimeLightInput = { includeRuntimeInfo: false, hydrateLiveAgentWindows: false };
  const runtimeFullInput = { hydrateLiveAgentWindows: false };
  const runtimeLight = normalize(buildDesktopStateSnapshot(buildHost(), runtimeLightInput));
  const runtimeFull = normalize(buildDesktopStateSnapshot(buildHost(), runtimeFullInput));

  resetExchangeStoreStats();
  resetTopologyStoreStats();
  resetWorktreeGitCallCount();
  buildDesktopStateSnapshot(buildHost(), runtimeLightInput);
  const costModel = {
    exchangeReads: getExchangeStoreStats().reads,
    topologyReads: getTopologyStoreStats().reads,
    exchangeParses: getExchangeStoreStats().parses,
    topologyParses: getTopologyStoreStats().parses,
    gitCalls: getWorktreeGitCallCount(),
  };

  const existingGolden = JSON.parse(
    readFileSync(new URL("src/multiplexer/desktop-state-golden.fixture.json", ROOT), "utf8"),
  );
  const cases = [
    {
      id: "desktop-state-golden-001",
      name: "runtime-light snapshot",
      source: "src/multiplexer/desktop-state-golden.test.ts",
      api: "buildDesktopStateSnapshot",
      input: runtimeLightInput,
      output: runtimeLight,
      inputSha256: hash(runtimeLightInput),
    },
    {
      id: "desktop-state-golden-002",
      name: "runtime-full snapshot",
      source: "src/multiplexer/desktop-state-golden.test.ts",
      api: "buildDesktopStateSnapshot",
      input: runtimeFullInput,
      output: runtimeFull,
      inputSha256: hash(runtimeFullInput),
    },
    {
      id: "desktop-state-golden-003",
      name: "runtime-full path remains distinct from runtime-light",
      source: "src/multiplexer/desktop-state-golden.test.ts",
      api: "buildDesktopStateSnapshot",
      input: { runtimeLightId: "desktop-state-golden-001", runtimeFullId: "desktop-state-golden-002" },
      output: {
        equal: JSON.stringify(runtimeFull) === JSON.stringify(runtimeLight),
        runtimeFullFirstSessionPid: runtimeFull.sessions?.[0]?.pid ?? null,
        runtimeLightFirstSessionPid: runtimeLight.sessions?.[0]?.pid ?? null,
      },
      inputSha256: hash({ runtimeLightId: "desktop-state-golden-001", runtimeFullId: "desktop-state-golden-002" }),
    },
    {
      id: "desktop-state-golden-004",
      name: "snapshot cost model",
      source: "src/multiplexer/desktop-state-golden.test.ts",
      api: "buildDesktopStateSnapshot",
      input: runtimeLightInput,
      output: costModel,
      inputSha256: hash({ runtimeLightInput, costModel: true }),
    },
  ];

  await writeContractJson(FIXTURE_PATH, {
    version: 1,
    generatedAt: "2026-09-07T00:00:00.000Z",
    generatedBy: "scripts/capture-desktop-state-golden-contract.mjs",
    source: "src/multiplexer/desktop-state-golden.test.ts",
    sources: ["src/multiplexer/desktop-state-golden.test.ts", "src/multiplexer/dashboard-model.ts"],
    subject: "buildDesktopStateSnapshot golden snapshots",
    description:
      "Runtime-light/runtime-full desktop-state snapshots and cost model captured by running TypeScript buildDesktopStateSnapshot.",
    caseCount: cases.length,
    cases,
    legacyFixtureMatches: {
      runtimeLight: JSON.stringify(existingGolden.runtimeLight) === JSON.stringify(runtimeLight),
      runtimeFull: JSON.stringify(existingGolden.runtimeFull) === JSON.stringify(runtimeFull),
      costModel: existingGolden.costModel.exchangeReads === costModel.exchangeReads,
    },
  });
  console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
} finally {
  if (repoRoot) rmSync(repoRoot, { recursive: true, force: true });
}
