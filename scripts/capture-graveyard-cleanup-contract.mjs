#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/graveyard/cleanup.json", ROOT);
const cleanup = await import(new URL("dist/graveyard-cleanup.js", ROOT));
const paths = await import(new URL("dist/paths.js", ROOT));
const metadata = await import(new URL("dist/metadata-store.js", ROOT));
const topology = await import(new URL("dist/runtime-core/topology-sessions.js", ROOT));

const { buildGraveyardCleanupPlan, deleteGraveyardAgent, runGraveyardCleanup } = cleanup;
const {
  getContextDir,
  getHistoryDir,
  getPlansDir,
  getProjectStateDir,
  getRecordingsDir,
  getStatusDir,
  initPaths,
} = paths;
const { loadMetadataState, updateSessionMetadata } = metadata;
const { listTopologySessionStates, moveTopologySessionToGraveyard, upsertTopologySession } = topology;

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

function normalizePath(path, roots) {
  for (const [token, root] of roots) {
    if (path === root) return token;
    if (path.startsWith(`${root}/`)) return `${token}/${path.slice(root.length + 1)}`;
  }
  return path;
}

function normalizeResult(value, roots) {
  if (Array.isArray(value)) return value.map((entry) => normalizeResult(entry, roots));
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, inner] of Object.entries(value)) {
    if ((key === "path" || key === "id") && typeof inner === "string") {
      output[key] = normalizePath(inner, roots);
    } else if (key === "removedAssets" && Array.isArray(inner)) {
      output[key] = inner.map((asset) => normalizePath(asset, roots)).sort();
    } else {
      output[key] = normalizeResult(inner, roots);
    }
  }
  return output;
}

function graveyardSession(id, nodeId, worktreePath) {
  const session = {
    id,
    nodeId,
    tool: "codex",
    toolConfigKey: "codex",
    command: "codex",
    args: [],
    status: "graveyard",
    updatedAt: "2026-05-30T00:00:00.000Z",
  };
  if (worktreePath) session.worktreePath = worktreePath;
  return session;
}

function oldWorktree() {
  return {
    id: "old-worktree",
    path: "/repo/.aimux/worktrees/old",
    name: "old",
    graveyardedAt: "2026-05-31T00:00:00.000Z",
  };
}

const cases = [];
function record(name, api, input, output) {
  cases.push({
    id: `graveyard-cleanup-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/graveyard-cleanup.test.ts",
    api,
    input,
    output,
    inputSha256: hash(input),
  });
}

record(
  "plans agents and worktrees whose graveyard lifetime has expired",
  "buildGraveyardCleanupPlan",
  {
    now: "2026-06-14T00:00:00.000Z",
    config: { cleanupEnabled: true, retentionDays: 14 },
    sessions: [
      graveyardSession("expired-agent", "node-agent"),
      {
        ...graveyardSession("fresh-agent", "node-fresh"),
        updatedAt: "2026-06-01T00:00:01.000Z",
        graveyardedAt: "2026-06-01T00:00:01.000Z",
      },
    ],
    worktrees: [
      oldWorktree(),
      { id: "fresh-worktree", path: "/repo/.aimux/worktrees/fresh", name: "fresh", graveyardedAt: "2026-06-01T00:00:01.000Z" },
    ],
  },
  buildGraveyardCleanupPlan({
    now: "2026-06-14T00:00:00.000Z",
    config: { cleanupEnabled: true, retentionDays: 14 },
    sessions: [
      graveyardSession("expired-agent", "node-agent"),
      {
        ...graveyardSession("fresh-agent", "node-fresh"),
        updatedAt: "2026-06-01T00:00:01.000Z",
        graveyardedAt: "2026-06-01T00:00:01.000Z",
      },
    ],
    worktrees: [
      oldWorktree(),
      { id: "fresh-worktree", path: "/repo/.aimux/worktrees/fresh", name: "fresh", graveyardedAt: "2026-06-01T00:00:01.000Z" },
    ],
  }),
);

record(
  "returns an empty plan when cleanup is disabled",
  "buildGraveyardCleanupPlan",
  {
    now: "2026-06-14T00:00:00.000Z",
    config: { cleanupEnabled: false, retentionDays: 14 },
    sessions: [graveyardSession("expired-agent", "node-agent")],
    worktrees: [oldWorktree()],
  },
  buildGraveyardCleanupPlan({
    now: "2026-06-14T00:00:00.000Z",
    config: { cleanupEnabled: false, retentionDays: 14 },
    sessions: [graveyardSession("expired-agent", "node-agent")],
    worktrees: [oldWorktree()],
  }),
);

record(
  "falls back to default retention when config retention is not numeric",
  "buildGraveyardCleanupPlan",
  {
    now: "2026-06-14T00:00:00.000Z",
    config: { cleanupEnabled: true, retentionDays: null },
    sessions: [{ ...graveyardSession("recent-agent", "node-agent"), updatedAt: "2026-06-10T00:00:00.000Z" }],
    worktrees: [],
  },
  buildGraveyardCleanupPlan({
    now: "2026-06-14T00:00:00.000Z",
    config: { cleanupEnabled: true, retentionDays: null },
    sessions: [{ ...graveyardSession("recent-agent", "node-agent"), updatedAt: "2026-06-10T00:00:00.000Z" }],
    worktrees: [],
  }),
);

async function recordRun(name, input, operations) {
  const deleteAgentCalls = [];
  const deleteWorktreeCalls = [];
  const result = await runGraveyardCleanup(
    buildGraveyardCleanupPlan(input.planInput),
    {
      deleteAgent: (sessionId) => {
        deleteAgentCalls.push(sessionId);
        return operations.deleteAgent(sessionId);
      },
      deleteWorktree: (path) => {
        deleteWorktreeCalls.push(path);
        return operations.deleteWorktree(path);
      },
    },
    input.run,
  );
  record(name, "runGraveyardCleanup", input, { result, deleteAgentCalls, deleteWorktreeCalls });
}

await recordRun(
  "does not run standalone agent cleanup for agents under an expired worktree",
  {
    planInput: {
      now: "2026-06-14T00:00:00.000Z",
      config: { cleanupEnabled: true, retentionDays: 14 },
      sessions: [graveyardSession("codex-old", "node-agent", "/repo/.aimux/worktrees/old")],
      worktrees: [oldWorktree()],
    },
  },
  {
    deleteAgent: (sessionId) => ({ sessionId, removedAssets: [] }),
    deleteWorktree: () => ({ path: "/repo/.aimux/worktrees/old", status: "removed" }),
  },
);

await recordRun(
  "continues dependent agent cleanup when expired worktree cleanup fails",
  {
    planInput: {
      now: "2026-06-14T00:00:00.000Z",
      config: { cleanupEnabled: true, retentionDays: 14 },
      sessions: [graveyardSession("codex-old", "node-agent", "/repo/.aimux/worktrees/old")],
      worktrees: [oldWorktree()],
    },
    operations: { worktreeError: "worktree remove failed" },
  },
  {
    deleteAgent: (sessionId) => ({ sessionId, removedAssets: [] }),
    deleteWorktree: () => {
      throw new Error("worktree remove failed");
    },
  },
);

await recordRun(
  "continues dependent agent cleanup when expired worktree cleanup reports a non-removed status",
  {
    planInput: {
      now: "2026-06-14T00:00:00.000Z",
      config: { cleanupEnabled: true, retentionDays: 14 },
      sessions: [graveyardSession("codex-old", "node-agent", "/repo/.aimux/worktrees/old")],
      worktrees: [oldWorktree()],
    },
    operations: { worktreeStatus: "not-found" },
  },
  {
    deleteAgent: (sessionId) => ({ sessionId, removedAssets: [] }),
    deleteWorktree: () => ({ path: "/repo/.aimux/worktrees/old", status: "not-found" }),
  },
);

await recordRun(
  "dry-run reports worktree and standalone agent targets without deleting them",
  {
    planInput: {
      now: "2026-06-14T00:00:00.000Z",
      config: { cleanupEnabled: true, retentionDays: 14 },
      sessions: [graveyardSession("codex-old", "node-agent")],
      worktrees: [oldWorktree()],
    },
    run: { dryRun: true },
  },
  {
    deleteAgent: (sessionId) => ({ sessionId, removedAssets: [] }),
    deleteWorktree: () => ({ path: "/repo/.aimux/worktrees/old", status: "removed" }),
  },
);

async function withProject(callback) {
  const previousHome = process.env.AIMUX_HOME;
  const aimuxHome = mkdtempSync(join(tmpdir(), "aimux-graveyard-cleanup-home-contract-"));
  const repoRoot = mkdtempSync(join(tmpdir(), "aimux-graveyard-cleanup-contract-"));
  process.env.AIMUX_HOME = aimuxHome;
  mkdirSync(join(repoRoot, ".git"), { recursive: true });
  try {
    await initPaths(repoRoot);
    return await callback(repoRoot, aimuxHome);
  } finally {
    if (previousHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previousHome;
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(aimuxHome, { recursive: true, force: true });
  }
}

record(
  "deletes standalone graveyard agent topology, metadata, and per-session assets",
  "deleteGraveyardAgent",
  { sessionId: "codex-old" },
  await withProject((repoRoot) => {
    upsertTopologySession({ id: "codex-old", tool: "codex", toolConfigKey: "codex", command: "codex", args: [] }, "offline");
    moveTopologySessionToGraveyard("codex-old", { now: "2026-05-30T00:00:00.000Z" });
    updateSessionMetadata("codex-old", (current) => ({ ...current, status: { text: "done" } }));
    const contextDir = join(getContextDir(), "codex-old");
    mkdirSync(contextDir, { recursive: true });
    mkdirSync(getRecordingsDir(), { recursive: true });
    writeFileSync(join(contextDir, "live.md"), "live\n");
    writeFileSync(join(getRecordingsDir(), "codex-old.log"), "raw\n");
    writeFileSync(join(getRecordingsDir(), "codex-old.txt"), "text\n");
    writeFileSync(join(getHistoryDir(), "codex-old.jsonl"), "{}\n");
    writeFileSync(join(getPlansDir(), "codex-old.md"), "# plan\n");
    writeFileSync(join(getStatusDir(), "codex-old.md"), "status\n");
    const settingsPath = join(getProjectStateDir(), "claude-settings", "codex-old.json");
    mkdirSync(join(getProjectStateDir(), "claude-settings"), { recursive: true });
    writeFileSync(settingsPath, "{}\n");
    const roots = [
      ["<project>", repoRoot],
      ["<projectState>", getProjectStateDir()],
    ];
    const deleted = deleteGraveyardAgent("codex-old");
    return normalizeResult(
      {
        deleted,
        settingsExists: existsSync(settingsPath),
        contextExists: existsSync(contextDir),
        recordingLogExists: existsSync(join(getRecordingsDir(), "codex-old.log")),
        metadataHasSession: Object.hasOwn(loadMetadataState().sessions, "codex-old"),
        graveyardSessions: listTopologySessionStates({ statuses: ["graveyard"] }),
      },
      roots,
    );
  }),
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/graveyard-cleanup.test.ts",
  generatedBy: "scripts/capture-graveyard-cleanup-contract.mjs",
  description: "Graveyard cleanup planning, callback ordering, dry-run/apply behavior, and standalone agent asset/state deletion captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
