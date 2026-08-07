import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { initPaths } from "../paths.js";
import {
  createRuntimeExchangeStore,
  getExchangeStoreStats,
  resetExchangeStoreStats,
} from "../runtime-core/exchange-store.js";
import { getTopologyStoreStats, resetTopologyStoreStats } from "../runtime-core/topology-store.js";
import { upsertTopologySession } from "../runtime-core/topology-sessions.js";
import { appendMessage, createThread } from "../threads.js";
import { writeTask } from "../tasks.js";
import { getWorktreeGitCallCount, listWorktrees, resetWorktreeGitCallCount } from "../worktree.js";
import { buildDesktopStateSnapshot } from "./dashboard-model.js";

/**
 * Characterization harness for `buildDesktopStateSnapshot`.
 *
 * The rest of the suite pins which host methods get called, not what the snapshot
 * contains — five of its eight fields are asserted nowhere. This asserts the whole
 * object against an explicit literal so a performance refactor cannot silently change
 * a value, drop a field, or reorder a list. The parse/spawn counters pin the cost model
 * the refactor is meant to change, so each win is an assertion rather than a benchmark.
 */

// Held in JSON rather than inline: ~16KB per snapshot is unreadable in-source, and a
// checked-in file stays diff-reviewable while — unlike `toMatchSnapshot` — never being
// blessed away by `vitest -u`. Regenerating it is a deliberate edit.
const GOLDEN = JSON.parse(readFileSync(join(import.meta.dirname, "desktop-state-golden.fixture.json"), "utf-8")) as {
  runtimeLight: unknown;
  runtimeFull: unknown;
  costModel: { exchangeParses: number; topologyParses: number; gitCalls: number };
};

const THREAD_COUNT = 16;
const MESSAGES_PER_THREAD = 3;

let repoRoot: string;
let worktreePath: string;

// Every timestamp is stamped deterministically after seeding: `createThread` and
// `appendMessage` derive createdAt/updatedAt from the wall clock, and `listThreads`
// sorts by updatedAt, so unpinned timestamps would make thread ordering — and the
// per-session threadId/threadName derived from it — nondeterministic.
function stampDeterministicTimestamps(): void {
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

function seedExchange(): void {
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
        // Leaving deliveredTo unset on the last message keeps a pending delivery,
        // which is what drives the workflow/pending counters on the snapshot.
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

function seedTopology(): void {
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

function buildHost(): any {
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
    getSessionLabel: (id: string) => `label-${id}`,
    deriveHeadline: (id: string) => `headline-${id}`,
    serviceLabelForCommand: (command: string) => `svc:${command}`,
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
    // Deterministic managed windows so the runtime-full path actually reaches
    // isWindowAlive and readTmuxProcessInfo; with an empty list it would produce
    // output identical to the runtime-light path and assert nothing extra.
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
      displayMessage: (_format: string, windowId: string) => `node\t${windowId === "@1" ? 4242 : 4243}`,
      captureTarget: (target: { windowId: string }) => `line one\nlast line for ${target.windowId}\n`,
    },
  };
}

// Temp dirs and the git-reported main-worktree path differ by /var vs /private/var on
// macOS, and every run gets a fresh random dir, so paths are normalized before comparison.
function normalize(value: unknown): unknown {
  const json = JSON.stringify(value);
  if (json === undefined) return value;
  return JSON.parse(json.split(worktreePath).join("<WORKTREE>").split(repoRoot).join("<REPO>"));
}

describe("desktop-state golden snapshot", () => {
  beforeAll(async () => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "aimux-desktop-golden-")));
    // A real repo with a real linked worktree: with only a bare `.git` directory,
    // findMainRepo/listWorktrees throw and are swallowed, so the git path goes untested.
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
  });

  afterAll(() => {
    if (repoRoot) rmSync(repoRoot, { recursive: true, force: true });
  });

  it("produces a stable runtime-light snapshot (the /desktop-state HTTP path)", () => {
    const snapshot = buildDesktopStateSnapshot(buildHost(), {
      includeRuntimeInfo: false,
      hydrateLiveAgentWindows: false,
    });
    expect(normalize(snapshot)).toEqual(GOLDEN.runtimeLight);
  });

  it("produces a stable runtime-full snapshot (the local TUI path)", () => {
    const snapshot = buildDesktopStateSnapshot(buildHost(), { hydrateLiveAgentWindows: false });
    expect(normalize(snapshot)).toEqual(GOLDEN.runtimeFull);
  });

  // The two paths must not collapse into each other: if the runtime-full path stopped
  // reading tmux, both goldens would still pass while covering half of what they claim.
  it("keeps the runtime-full path distinct from the runtime-light one", () => {
    expect(GOLDEN.runtimeFull).not.toEqual(GOLDEN.runtimeLight);
    expect((GOLDEN.runtimeFull as any).sessions[0].pid).toBe(4242);
    expect((GOLDEN.runtimeLight as any).sessions[0].pid).toBeUndefined();
  });

  // This pins the cost model the performance work targets. It is expected to change as
  // each phase lands — the goldens above are what must not.
  it("pins how much redundant work one snapshot build performs", () => {
    resetExchangeStoreStats();
    resetTopologyStoreStats();
    resetWorktreeGitCallCount();

    buildDesktopStateSnapshot(buildHost(), { includeRuntimeInfo: false, hydrateLiveAgentWindows: false });

    expect({
      exchangeParses: getExchangeStoreStats().parses,
      topologyParses: getTopologyStoreStats().parses,
      gitCalls: getWorktreeGitCallCount(),
    }).toEqual(GOLDEN.costModel);
  });
});
