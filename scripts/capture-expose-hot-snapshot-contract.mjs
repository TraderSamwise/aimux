#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/tmux/expose-hot-snapshot.json", ROOT);
const hot = await import(new URL("dist/tmux/expose-hot-snapshot.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

const item = (id = "session-1", windowId = "@1", output = "warm preview\n") => ({
  id,
  label: id,
  urgency: 0,
  activity: 0,
  recentRank: 0,
  previewSnapshot: {
    output,
    capturedAt: "2026-07-20T13:00:00.000Z",
    source: "capture",
    windowId,
    startLine: -40,
    lineCount: 40,
  },
  target: { sessionName: "aimux-test", windowId, windowIndex: 1, windowName: id },
  metadata: {
    kind: "agent",
    sessionId: id,
    command: "codex",
    args: [],
    toolConfigKey: "codex",
    worktreePath: "/repo",
  },
});

const view = (scope, items = [item()]) => ({
  scope,
  items,
  scopeLabel: scope === "global" ? "all projects" : scope === "worktree" ? "this worktree" : "all worktrees",
  sublabel: scope === "global" ? "project-worktree" : scope === "worktree" ? "none" : "worktree",
});

const generatedBoundsItems = ({ itemCount, lineCount, lineWidth, seed }) =>
  Array.from({ length: itemCount }, (_, index) =>
    item(
      `session-${index}`,
      `@${index}`,
      Array.from({ length: lineCount }, (__, line) => `${seed}:${index}:${line}:${"x".repeat(lineWidth)}`).join("\n"),
    ),
  );

const generatedBoundsView = (params) => view("project", generatedBoundsItems(params));

const normalize = (value) =>
  JSON.parse(
    JSON.stringify(value, (_key, nested) => {
      if (typeof nested !== "string") return nested;
      return nested.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, "<iso>");
    }),
  );

const expandFresh = (value) => {
  if (value === "<fresh>") return new Date().toISOString();
  if (Array.isArray(value)) return value.map(expandFresh);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, expandFresh(nested)]));
  return value;
};

const toTsOptions = (options) => {
  if (!options?.prune?.keepLaunchWindowIds) return options;
  return {
    ...options,
    prune: {
      ...options.prune,
      keepLaunchWindowIds: new Set(options.prune.keepLaunchWindowIds),
    },
  };
};

const snapshot = (stateDir) => {
  const path = join(stateDir, "expose-hot-snapshots.json");
  const lockPath = join(stateDir, "expose-hot-snapshots.lock");
  let json = null;
  let text = null;
  let mode = null;
  if (existsSync(path)) {
    text = readFileSync(path, "utf8");
    try {
      json = normalize(JSON.parse(text));
    } catch {
      json = null;
    }
    mode = (statSync(path).mode & 0o777).toString(8).padStart(3, "0");
  }
  return {
    exists: existsSync(path),
    lockExists: existsSync(lockPath),
    mode,
    json,
    textContainsSession119: text?.includes("session-119") ?? false,
  };
};

const boundsSummary = (value, stateDir) => {
  const path = join(stateDir, "expose-hot-snapshots.json");
  const firstOutput = value?.items?.[0]?.previewSnapshot?.output ?? "";
  return {
    itemCount: value?.items?.length ?? 0,
    firstPreviewLineCount: firstOutput ? firstOutput.split("\n").length : 0,
    firstPreviewBytes: Buffer.byteLength(firstOutput, "utf8"),
    firstPreviewEndsWithGeneratedTail: firstOutput.endsWith(`${"x".repeat(300)}`),
    cacheExists: existsSync(path),
    cacheMode: existsSync(path) ? (statSync(path).mode & 0o777).toString(8).padStart(3, "0") : null,
    cacheContainsPrunedItem: existsSync(path) ? readFileSync(path, "utf8").includes("session-100") : false,
  };
};

function generatedBoundsTrips(params) {
  const root = mkdtempSync(join(tmpdir(), "aimux-expose-hot-snapshot-probe-"));
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  hot.writeHotExposeScopeView(stateDir, { projectRoot: "/repo", scope: "project" }, generatedBoundsView(params));
  const loaded = hot.readHotExposeScopeView(stateDir, { projectRoot: "/repo", scope: "project" });
  const output = loaded?.items?.[0]?.previewSnapshot?.output ?? "";
  const trips =
    (loaded?.items?.length ?? 0) === 100 &&
    params.itemCount > 100 &&
    Buffer.byteLength(output, "utf8") === 16 * 1024;
  rmSync(root, { recursive: true, force: true });
  return trips;
}

function findSmallestBoundsGenerator() {
  for (const itemCount of [100, 101]) {
    for (const lineCount of [1, 2, 40, 80, 81]) {
      let low = 1;
      let high = 20 * 1024;
      let best = null;
      while (low <= high) {
        const lineWidth = Math.floor((low + high) / 2);
        const params = { itemCount, lineCount, lineWidth, seed: "bounds" };
        if (generatedBoundsTrips(params)) {
          best = lineWidth;
          high = lineWidth - 1;
        } else {
          low = lineWidth + 1;
        }
      }
      if (best !== null) return { itemCount, lineCount, lineWidth: best, seed: "bounds" };
    }
  }
  throw new Error("could not find generated bounds input that trips item and preview limits");
}

const cases = [];
function record(name, operations) {
  const root = mkdtempSync(join(tmpdir(), "aimux-expose-hot-snapshot-contract-"));
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  const results = [];
  for (const op of operations) {
    if (op.type === "write") {
      hot.writeHotExposeScopeView(stateDir, op.key, op.view, toTsOptions(op.options));
      results.push({ type: op.type, snapshot: snapshot(stateDir) });
    } else if (op.type === "writeGeneratedBounds") {
      hot.writeHotExposeScopeView(stateDir, op.key, generatedBoundsView(op.generator), toTsOptions(op.options));
      results.push({
        type: op.type,
        bounds: boundsSummary(hot.readHotExposeScopeView(stateDir, op.key), stateDir),
      });
    } else if (op.type === "readBounds") {
      results.push({
        type: op.type,
        bounds: boundsSummary(hot.readHotExposeScopeView(stateDir, op.key), stateDir),
      });
    } else if (op.type === "read") {
      results.push({
        type: op.type,
        value: hot.readHotExposeScopeView(stateDir, op.key),
        snapshot: snapshot(stateDir),
      });
    } else if (op.type === "raw") {
      writeFileSync(join(stateDir, "expose-hot-snapshots.json"), op.text);
      results.push({ type: op.type, snapshot: snapshot(stateDir) });
    } else if (op.type === "rawJson") {
      writeFileSync(join(stateDir, "expose-hot-snapshots.json"), JSON.stringify(expandFresh(op.value), null, 2));
      results.push({ type: op.type, snapshot: snapshot(stateDir) });
    } else if (op.type === "prune") {
      results.push({
        type: op.type,
        value: hot.pruneExpiredHotExposeSnapshots(stateDir),
        snapshot: snapshot(stateDir),
      });
    } else if (op.type === "lock") {
      const lockPath = join(stateDir, "expose-hot-snapshots.lock");
      mkdirSync(lockPath);
      if (op.stale) {
        const staleTime = new Date(Date.now() - 6000);
        utimesSync(lockPath, staleTime, staleTime);
      }
      results.push({ type: op.type, snapshot: snapshot(stateDir) });
    }
  }
  rmSync(root, { recursive: true, force: true });
  const input = normalize({ name, operations });
  cases.push({
    id: `tmux-expose-hot-snapshot-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/tmux/expose-hot-snapshot.test.ts",
    api: "src/tmux/expose-hot-snapshot.ts",
    input,
    output: normalize({ results }),
    inputSha256: hash(input),
  });
}

record("round-trips a valid scoped snapshot", [
  { type: "write", key: { projectRoot: "/repo", scope: "project" }, view: view("project") },
  { type: "read", key: { projectRoot: "/repo", scope: "project" } },
]);
record("does not reuse one worktree snapshot for another worktree", [
  {
    type: "write",
    key: { projectRoot: "/repo", scope: "worktree", worktreeKey: "/repo/worktrees/a" },
    view: view("worktree", [item("a", "@1")]),
  },
  { type: "read", key: { projectRoot: "/repo", scope: "worktree", worktreeKey: "/repo/worktrees/b" } },
]);
record("does not reuse one launch window snapshot for another worktree launcher", [
  {
    type: "write",
    key: { projectRoot: "/repo", scope: "worktree", worktreeKey: "/repo", launchWindowId: "@1" },
    view: view("worktree", [item("a", "@1")]),
  },
  { type: "read", key: { projectRoot: "/repo", scope: "worktree", worktreeKey: "/repo", launchWindowId: "@2" } },
]);
record("ignores malformed cache files", [
  { type: "raw", text: "{" },
  { type: "read", key: { projectRoot: "/repo", scope: "project" } },
]);
record("removes expired preview bodies when a stale cache is read", [
  {
    type: "rawJson",
    value: {
      version: 1,
      views: {
        "project|%2Frepo||": {
          ...view("project", [item("session-1", "@1", "SECRET_TOKEN=should-not-persist\n")]),
          projectRoot: "/repo",
          updatedAt: "2020-01-01T00:00:00.000Z",
        },
      },
    },
  },
  { type: "read", key: { projectRoot: "/repo", scope: "project" } },
]);
record("removes cached previews when a long-lived owner prunes expired entries", [
  {
    type: "rawJson",
    value: {
      version: 1,
      views: {
        "project|%2Frepo||": {
          ...view("project", [item("session-1", "@1", "SECRET_TOKEN=should-expire\n")]),
          projectRoot: "/repo",
          updatedAt: "2020-01-01T00:00:00.000Z",
        },
      },
    },
  },
  { type: "prune" },
]);
record("replaces a malformed cache file on the next successful write", [
  { type: "raw", text: "{" },
  { type: "write", key: { projectRoot: "/repo", scope: "project" }, view: view("project") },
  { type: "read", key: { projectRoot: "/repo", scope: "project" } },
]);
record("writes derived cache files with owner-only permissions", [
  { type: "write", key: { projectRoot: "/repo", scope: "project" }, view: view("project") },
]);
record("recovers from a stale write lock", [
  { type: "lock", stale: true },
  { type: "write", key: { projectRoot: "/repo", scope: "project" }, view: view("project") },
  { type: "read", key: { projectRoot: "/repo", scope: "project" } },
]);
record("skips writes behind a live write lock without blocking", [
  { type: "lock" },
  { type: "write", key: { projectRoot: "/repo", scope: "project" }, view: view("project") },
  { type: "read", key: { projectRoot: "/repo", scope: "project" } },
]);
const boundsGenerator = findSmallestBoundsGenerator();
record("bounds cached preview output and item count", [
  {
    type: "writeGeneratedBounds",
    key: { projectRoot: "/repo", scope: "project" },
    generator: boundsGenerator,
  },
  { type: "readBounds", key: { projectRoot: "/repo", scope: "project" } },
]);
record("ignores cached items that are missing target or metadata shape", [
  {
    type: "rawJson",
    value: {
      version: 1,
      views: {
        "project|%2Frepo||": {
          scope: "project",
          projectRoot: "/repo",
          scopeLabel: "all worktrees",
          sublabel: "worktree",
          updatedAt: "<fresh>",
          items: [{ id: "bad", label: "bad", urgency: 0, activity: 0, recentRank: 0 }],
        },
      },
    },
  },
  { type: "read", key: { projectRoot: "/repo", scope: "project" } },
]);
record("prunes stale launch window views while preserving kept windows", [
  {
    type: "write",
    key: { projectRoot: "/repo", scope: "worktree", worktreeKey: "/repo", launchWindowId: "@1" },
    view: view("worktree", [item("a", "@1")]),
  },
  {
    type: "write",
    key: { projectRoot: "/repo", scope: "worktree", worktreeKey: "/repo", launchWindowId: "@2" },
    view: view("worktree", [item("b", "@2")]),
    options: { prune: { projectRoot: "/repo", scopes: ["worktree"], keepLaunchWindowIds: ["@2"] } },
  },
  { type: "read", key: { projectRoot: "/repo", scope: "worktree", worktreeKey: "/repo", launchWindowId: "@1" } },
  { type: "read", key: { projectRoot: "/repo", scope: "worktree", worktreeKey: "/repo", launchWindowId: "@2" } },
]);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-06T00:00:00.000Z",
  generatedBy: "scripts/capture-expose-hot-snapshot-contract.mjs",
  source: "src/tmux/expose-hot-snapshot.test.ts",
  subject: "src/tmux/expose-hot-snapshot.ts",
  description: "Expose hot snapshot cache behavior captured by running the TypeScript implementation.",
  caseCount: cases.length,
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
