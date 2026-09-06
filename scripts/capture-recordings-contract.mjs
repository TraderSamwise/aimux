#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const CLEANUP_PATH = new URL("testdata/contracts/v1/recordings/cleanup.json", ROOT);
const CONFIG_PATH = new URL("testdata/contracts/v1/recordings/config.json", ROOT);
const cleanup = await import(new URL("dist/recording-cleanup.js", ROOT));
const config = await import(new URL("dist/recording-config.js", ROOT));

const { DEFAULT_RECORDING_RETENTION_DAYS, planRecordingCleanup, runRecordingCleanup } = cleanup;
const { DEFAULT_RECORDINGS_CONFIG, MIN_RECORDING_RETENTION_DAYS, normalizeRecordingsConfig } = config;

const NOW = Date.UTC(2026, 7, 8);
const DAY = 24 * 60 * 60 * 1000;

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

function normalizePlan(plan, roots) {
  return {
    retentionDays: plan.retentionDays,
    remove: plan.remove.map((entry) => ({
      path: normalizePath(entry.path, roots),
      name: basename(entry.path),
      ageDays: Number(entry.ageDays.toFixed(6)),
      sizeBytes: entry.sizeBytes,
    })),
    keptCount: plan.keptCount,
    reclaimableBytes: plan.reclaimableBytes,
  };
}

function normalizeRun(result, roots, removed) {
  return {
    dryRun: result.dryRun,
    plan: normalizePlan(result.plan, roots),
    removed: result.removed,
    failed: result.failed,
    reclaimedBytes: result.reclaimedBytes,
    removedPaths: removed.map((path) => normalizePath(path, roots)),
  };
}

function makeRecording(projectsRoot, project, name, ageDays, bytes = 512) {
  const dir = join(projectsRoot, project, "recordings");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "x".repeat(bytes));
  const seconds = (NOW - ageDays * DAY) / 1000;
  utimesSync(path, seconds, seconds);
  return path;
}

async function withProjects(callback) {
  const projectsRoot = mkdtempSync(join(tmpdir(), "aimux-recordings-contract-"));
  try {
    return await callback(projectsRoot);
  } finally {
    rmSync(projectsRoot, { recursive: true, force: true });
  }
}

const cleanupCases = [];
function recordCleanup(name, input, output) {
  cleanupCases.push({
    id: `recordings-cleanup-${String(cleanupCases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/recording-cleanup.test.ts",
    api: input.api,
    input,
    output,
    inputSha256: hash(input),
  });
}

recordCleanup(
  "removes recordings past retention across every project",
  {
    api: "planRecordingCleanup",
    now: NOW,
    projects: [
      { project: "alpha", name: "claude-a.log", ageDays: 90, bytes: 512 },
      { project: "beta", name: "codex-b.log", ageDays: 45, bytes: 512 },
    ],
  },
  await withProjects((projectsRoot) => {
    makeRecording(projectsRoot, "alpha", "claude-a.log", 90);
    makeRecording(projectsRoot, "beta", "codex-b.log", 45);
    return normalizePlan(planRecordingCleanup({ projectsRoot, now: () => NOW }), [["<projectsRoot>", projectsRoot]]);
  }),
);

recordCleanup(
  "keeps a recording a live session is still writing",
  { api: "planRecordingCleanup", now: NOW, projects: [{ project: "alpha", name: "claude-live.log", ageDays: 0, bytes: 512 }] },
  await withProjects((projectsRoot) => {
    makeRecording(projectsRoot, "alpha", "claude-live.log", 0);
    return normalizePlan(planRecordingCleanup({ projectsRoot, now: () => NOW }), [["<projectsRoot>", projectsRoot]]);
  }),
);

recordCleanup(
  "reaches recordings whose session no longer exists in project state",
  { api: "planRecordingCleanup", now: NOW, projects: [{ project: "alpha", name: "claude-orphaned.log", ageDays: 400, bytes: 4096 }] },
  await withProjects((projectsRoot) => {
    makeRecording(projectsRoot, "alpha", "claude-orphaned.log", 400, 4096);
    return normalizePlan(planRecordingCleanup({ projectsRoot, now: () => NOW }), [["<projectsRoot>", projectsRoot]]);
  }),
);

recordCleanup(
  "offers the biggest recordings first",
  {
    api: "planRecordingCleanup",
    now: NOW,
    projects: [
      { project: "alpha", name: "small.log", ageDays: 90, bytes: 100 },
      { project: "alpha", name: "huge.log", ageDays: 90, bytes: 9000 },
      { project: "alpha", name: "medium.log", ageDays: 90, bytes: 1000 },
    ],
  },
  await withProjects((projectsRoot) => {
    makeRecording(projectsRoot, "alpha", "small.log", 90, 100);
    makeRecording(projectsRoot, "alpha", "huge.log", 90, 9000);
    makeRecording(projectsRoot, "alpha", "medium.log", 90, 1000);
    return normalizePlan(planRecordingCleanup({ projectsRoot, now: () => NOW }), [["<projectsRoot>", projectsRoot]]);
  }),
);

recordCleanup(
  "returns an empty plan when no projects directory exists",
  { api: "planRecordingCleanup", now: NOW, missingProjectsRoot: true },
  await withProjects((projectsRoot) =>
    normalizePlan(planRecordingCleanup({ projectsRoot: join(projectsRoot, "missing"), now: () => NOW }), [["<projectsRoot>", projectsRoot]]),
  ),
);

recordCleanup(
  "removes nothing unless the caller opts in",
  { api: "runRecordingCleanup", now: NOW, projects: [{ project: "alpha", name: "old.log", ageDays: 90, bytes: 512 }], run: {} },
  await withProjects(async (projectsRoot) => {
    makeRecording(projectsRoot, "alpha", "old.log", 90);
    const removed = [];
    const result = await runRecordingCleanup(planRecordingCleanup({ projectsRoot, now: () => NOW }), { removeFile: (path) => removed.push(path) });
    return normalizeRun(result, [["<projectsRoot>", projectsRoot]], removed);
  }),
);

recordCleanup(
  "removes the planned recordings when asked",
  { api: "runRecordingCleanup", now: NOW, projects: [{ project: "alpha", name: "old.log", ageDays: 90, bytes: 2048 }], run: { dryRun: false } },
  await withProjects(async (projectsRoot) => {
    makeRecording(projectsRoot, "alpha", "old.log", 90, 2048);
    const removed = [];
    const result = await runRecordingCleanup(
      planRecordingCleanup({ projectsRoot, now: () => NOW }),
      { removeFile: (path) => removed.push(path) },
      { dryRun: false },
    );
    return normalizeRun(result, [["<projectsRoot>", projectsRoot]], removed);
  }),
);

recordCleanup(
  "counts a failed removal without aborting the sweep",
  {
    api: "runRecordingCleanup",
    now: NOW,
    projects: [
      { project: "alpha", name: "bad.log", ageDays: 90, bytes: 512 },
      { project: "alpha", name: "good.log", ageDays: 91, bytes: 512 },
    ],
    run: { dryRun: false, failNames: ["bad.log"] },
  },
  await withProjects(async (projectsRoot) => {
    makeRecording(projectsRoot, "alpha", "bad.log", 90);
    makeRecording(projectsRoot, "alpha", "good.log", 91);
    const removed = [];
    const result = await runRecordingCleanup(
      planRecordingCleanup({ projectsRoot, now: () => NOW }),
      {
        removeFile: (path) => {
          if (path.endsWith("bad.log")) throw new Error("permission denied");
          removed.push(path);
        },
      },
      { dryRun: false },
    );
    return normalizeRun(result, [["<projectsRoot>", projectsRoot]], removed);
  }),
);

recordCleanup(
  "caps how many it removes in one sweep",
  {
    api: "runRecordingCleanup",
    now: NOW,
    projects: [
      { project: "alpha", name: "a.log", ageDays: 90, bytes: 300 },
      { project: "alpha", name: "b.log", ageDays: 90, bytes: 200 },
      { project: "alpha", name: "c.log", ageDays: 90, bytes: 100 },
    ],
    run: { dryRun: false, limit: 2 },
  },
  await withProjects(async (projectsRoot) => {
    makeRecording(projectsRoot, "alpha", "a.log", 90, 300);
    makeRecording(projectsRoot, "alpha", "b.log", 90, 200);
    makeRecording(projectsRoot, "alpha", "c.log", 90, 100);
    const removed = [];
    const result = await runRecordingCleanup(
      planRecordingCleanup({ projectsRoot, now: () => NOW }),
      { removeFile: (path) => removed.push(path) },
      { dryRun: false, limit: 2 },
    );
    return normalizeRun(result, [["<projectsRoot>", projectsRoot]], removed);
  }),
);

recordCleanup(
  "keeps a recording whose session the project still knows about",
  {
    api: "planRecordingCleanup",
    now: NOW,
    projects: [{ project: "alpha", name: "claude-idle.log", ageDays: 400, bytes: 512 }],
    state: { alpha: { sessions: [{ id: "claude-idle" }] } },
  },
  await withProjects((projectsRoot) => {
    makeRecording(projectsRoot, "alpha", "claude-idle.log", 400);
    writeFileSync(join(projectsRoot, "alpha", "state.json"), JSON.stringify({ sessions: [{ id: "claude-idle" }] }));
    return normalizePlan(planRecordingCleanup({ projectsRoot, now: () => NOW }), [["<projectsRoot>", projectsRoot]]);
  }),
);

recordCleanup(
  "still removes a recording whose session is gone from state",
  {
    api: "planRecordingCleanup",
    now: NOW,
    projects: [{ project: "alpha", name: "claude-gone.log", ageDays: 400, bytes: 512 }],
    state: { alpha: { sessions: [] } },
  },
  await withProjects((projectsRoot) => {
    makeRecording(projectsRoot, "alpha", "claude-gone.log", 400);
    writeFileSync(join(projectsRoot, "alpha", "state.json"), JSON.stringify({ sessions: [] }));
    return normalizePlan(planRecordingCleanup({ projectsRoot, now: () => NOW }), [["<projectsRoot>", projectsRoot]]);
  }),
);

recordCleanup(
  "sweeps recordings kept beside a repo, not just the global layout",
  { api: "planRecordingCleanup", now: NOW, extraDirs: [{ token: "<extra:local>", name: "codex-local.log", ageDays: 90, bytes: 256 }] },
  await withProjects((projectsRoot) => {
    const local = join(projectsRoot, "worktree", ".aimux", "recordings");
    mkdirSync(local, { recursive: true });
    const path = join(local, "codex-local.log");
    writeFileSync(path, "x".repeat(256));
    const seconds = (NOW - 90 * DAY) / 1000;
    utimesSync(path, seconds, seconds);
    return normalizePlan(planRecordingCleanup({ projectsRoot, extraDirs: [local], now: () => NOW }), [
      ["<extra:local>", local],
      ["<projectsRoot>", projectsRoot],
    ]);
  }),
);

recordCleanup(
  "defaults to a conservative retention",
  { api: "DEFAULT_RECORDING_RETENTION_DAYS" },
  DEFAULT_RECORDING_RETENTION_DAYS,
);

const configCases = [];
function recordConfig(name, raw) {
  const input = { raw };
  configCases.push({
    id: `recordings-config-${String(configCases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/recording-config.test.ts",
    api: "normalizeRecordingsConfig",
    input,
    output: normalizeRecordingsConfig(raw),
    inputSha256: hash(input),
  });
}

recordConfig("falls back to defaults when absent", undefined);
recordConfig("falls back to defaults when malformed", "on");
recordConfig("falls back to defaults when retention is non-numeric", { retentionDays: "soon" });
recordConfig("gives the sweep an off switch", { cleanupEnabled: false });
recordConfig("refuses a zero-day retention", { retentionDays: 0 });
recordConfig("refuses a negative retention", { retentionDays: -1 });
recordConfig("allows the configured minimum retention", { retentionDays: MIN_RECORDING_RETENTION_DAYS });
recordConfig("ignores an out-of-range retention rather than clamping it", { retentionDays: 99_999 });

await writeContractJson(CLEANUP_PATH, {
  version: 1,
  source: "src/recording-cleanup.test.ts",
  generatedBy: "scripts/capture-recordings-contract.mjs",
  description: "Recording cleanup planning, execution, retention defaults, live-session guards, size ordering, limits, and side effects captured by running TypeScript.",
  cases: cleanupCases,
});
await writeContractJson(CONFIG_PATH, {
  version: 1,
  source: "src/recording-config.test.ts",
  generatedBy: "scripts/capture-recordings-contract.mjs",
  description: "Recording cleanup global config normalization captured by running TypeScript.",
  constants: {
    DEFAULT_RECORDINGS_CONFIG,
    MIN_RECORDING_RETENTION_DAYS,
  },
  cases: configCases,
});
console.log(`${CLEANUP_PATH.pathname}: ${cleanupCases.length} cases`);
console.log(`${CONFIG_PATH.pathname}: ${configCases.length} cases`);
