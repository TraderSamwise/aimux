#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/tmux/expose-ordering.json", ROOT);
const {
  assignWorktreeTones,
  dashboardWorktreeOrderPaths,
  exposeTileContextForItem,
  groupItemsByProject,
  groupItemsByWorktree,
  orderExposeItems,
  orderExposeItemsByRecentOutput,
  shortWorktree,
  worktreeToneKey,
} = await import(new URL("dist/tmux/expose-ordering.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function item(id, options = {}) {
  const metadata = {
    kind: "agent",
    sessionId: id,
    command: id,
    args: [],
    toolConfigKey: id,
    label: id,
  };
  if (options.worktreePath !== undefined) metadata.worktreePath = options.worktreePath;
  if (options.recencyAt !== undefined) metadata.recencyAt = options.recencyAt;
  return {
    id,
    target: { sessionName: "aimux-repo", windowId: id, windowIndex: 1, windowName: id },
    metadata,
    label: id,
    urgency: 0,
    activity: 1,
    recentRank: options.recentRank ?? Number.MAX_SAFE_INTEGER,
    overseer: false,
    scribe: false,
    alive: true,
    projectRoot: options.projectRoot,
    projectName: options.projectName,
  };
}

const ids = (items) => items.map((entry) => entry.target.windowId);
const groups = (entries) => entries.map((entry) => ({ label: entry.label, itemIds: ids(entry.items) }));
const tonesObject = (tones) => Object.fromEntries([...tones.entries()]);

const cases = [];
function record(name, api, input, run) {
  cases.push({
    id: `expose-ordering-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/tmux/expose-ordering.ts",
    api,
    input,
    output: run(input),
    inputSha256: hash(input),
  });
}

record(
  "short worktree maps missing and project root to main",
  "shortWorktree",
  {
    projectRoot: "/repo",
    items: [
      item("missing"),
      item("root", { worktreePath: "/repo" }),
      item("clean-root", { worktreePath: "/repo/wt/.." }),
    ],
  },
  ({ projectRoot, items }) => ({ values: items.map((entry) => shortWorktree(entry, projectRoot)) }),
);

record(
  "short worktree uses basename after path resolution",
  "shortWorktree",
  {
    projectRoot: "/repo",
    items: [
      item("nested", { worktreePath: "/repo/.aimux/worktrees/custom/" }),
      item("relative-clean", { worktreePath: "/repo/wt/../feature-a" }),
    ],
  },
  ({ projectRoot, items }) => ({ values: items.map((entry) => shortWorktree(entry, projectRoot)) }),
);

record(
  "tone key resolves worktree paths with fallback project root",
  "worktreeToneKey",
  {
    projectRoot: "/repo",
    items: [item("fallback"), item("clean", { worktreePath: "/repo/wt/../feature-a" })],
  },
  ({ projectRoot, items }) => ({ values: items.map((entry) => worktreeToneKey(entry, projectRoot)) }),
);

record(
  "groups projects by first seen trimmed labels",
  "groupItemsByProject",
  {
    items: [
      item("b1", { projectName: " beta " }),
      item("unknown-1"),
      item("a1", { projectName: "alpha" }),
      item("unknown-2", { projectName: "  " }),
      item("b2", { projectName: "beta" }),
    ],
  },
  ({ items }) => ({ groups: groups(groupItemsByProject(items)) }),
);

record(
  "groups worktrees by configured dashboard order",
  "groupItemsByWorktree",
  {
    projectRoot: "/repo",
    options: {
      worktreeOrderByProjectRoot: {
        "/repo": ["/repo/wt/known", "/repo", "/repo/wt/known", "/repo/wt/later"],
      },
    },
    items: [
      item("orphan-1", { worktreePath: "/repo/wt/orphan" }),
      item("known-1", { worktreePath: "/repo/wt/known" }),
      item("main-1", { worktreePath: "/repo" }),
      item("later-1", { worktreePath: "/repo/wt/later" }),
      item("orphan-2", { worktreePath: "/repo/wt/orphan" }),
    ],
  },
  ({ items, projectRoot, options }) => ({ groups: groups(groupItemsByWorktree(items, projectRoot, options)) }),
);

record(
  "groups worktrees pins missing configured root first",
  "groupItemsByWorktree",
  {
    projectRoot: "/repo",
    options: {
      worktreeOrderByProjectRoot: {
        "/repo": ["/repo/wt/known"],
      },
    },
    items: [
      item("known-1", { worktreePath: "/repo/wt/known" }),
      item("main-1", { worktreePath: "/repo" }),
      item("other-1", { worktreePath: "/repo/wt/other" }),
    ],
  },
  ({ items, projectRoot, options }) => ({ groups: groups(groupItemsByWorktree(items, projectRoot, options)) }),
);

record(
  "orders global items by first seen project then worktree order",
  "orderExposeItems",
  {
    projectRoot: "/fallback",
    sublabel: "project-worktree",
    options: {
      worktreeOrderByProjectRoot: {
        "/beta": ["/beta", "/beta/.aimux/worktrees/custom"],
        "/alpha": ["/alpha"],
      },
    },
    items: [
      item("beta-custom-1", {
        projectName: "beta",
        projectRoot: "/beta",
        worktreePath: "/beta/.aimux/worktrees/custom",
      }),
      item("alpha-main-1", { projectName: "alpha", projectRoot: "/alpha", worktreePath: "/alpha" }),
      item("beta-main-1", { projectName: "beta", projectRoot: "/beta", worktreePath: "/beta" }),
      item("alpha-main-2", { projectName: "alpha", projectRoot: "/alpha", worktreePath: "/alpha" }),
      item("beta-custom-2", {
        projectName: "beta",
        projectRoot: "/beta",
        worktreePath: "/beta/.aimux/worktrees/custom",
      }),
    ],
  },
  ({ items, projectRoot, sublabel, options }) => ({
    itemIds: ids(
      orderExposeItems({ scope: "global", items, scopeLabel: "all projects", sublabel }, projectRoot, options),
    ),
  }),
);

record(
  "orders single project global items by worktree",
  "orderExposeItems",
  {
    projectRoot: "/fallback",
    sublabel: "project-worktree",
    options: { worktreeOrderByProjectRoot: { "/repo": ["/repo", "/repo/wt/custom"] } },
    items: [
      item("custom-1", { projectName: "alpha", projectRoot: "/repo", worktreePath: "/repo/wt/custom" }),
      item("main-1", { projectName: "alpha", projectRoot: "/repo", worktreePath: "/repo" }),
      item("custom-2", { projectName: "alpha", projectRoot: "/repo", worktreePath: "/repo/wt/custom" }),
    ],
  },
  ({ items, projectRoot, sublabel, options }) => ({
    itemIds: ids(
      orderExposeItems({ scope: "global", items, scopeLabel: "all projects", sublabel }, projectRoot, options),
    ),
  }),
);

record(
  "keeps none sublabel order unchanged",
  "orderExposeItems",
  {
    projectRoot: "/repo",
    sublabel: "none",
    options: { worktreeOrderByProjectRoot: { "/repo": ["/repo"] } },
    items: [item("custom-1", { worktreePath: "/repo/wt/custom" }), item("main-1", { worktreePath: "/repo" })],
  },
  ({ items, projectRoot, sublabel, options }) => ({
    itemIds: ids(
      orderExposeItems({ scope: "global", items, scopeLabel: "all projects", sublabel }, projectRoot, options),
    ),
  }),
);

record(
  "sorts recent output by timestamp rank then original order",
  "orderExposeItemsByRecentOutput",
  {
    items: [
      item("older", { recencyAt: "2026-08-27T10:00:00.000Z", recentRank: 2, worktreePath: "/repo" }),
      item("invalid-newer-rank", { recencyAt: "not-a-date", recentRank: 0, worktreePath: "/repo" }),
      item("newer", { recencyAt: "2026-08-27T10:05:00.000Z", recentRank: 1, worktreePath: "/repo/wt/a" }),
      item("missing-older-rank", { recentRank: 3, worktreePath: "/repo/wt/b" }),
    ],
  },
  ({ items }) => ({ itemIds: ids(orderExposeItemsByRecentOutput(items)) }),
);

record(
  "dashboard worktree order filters bare and sorts by created time",
  "dashboardWorktreeOrderPaths",
  {
    projectRoot: "/repo",
    worktrees: [
      { name: "repo", path: "/repo", branch: "master", isBare: false, createdAt: "2026-01-01T00:00:00.000Z" },
      { name: "bare", path: "/repo/bare", branch: "bare", isBare: true, createdAt: "2026-01-04T00:00:00.000Z" },
      {
        name: "missing",
        path: "/repo/missing",
        branch: "missing",
        isBare: false,
        status: "removed",
        createdAt: "2026-01-05T00:00:00.000Z",
      },
      { name: "old", path: "/repo/wt/old", branch: "old", isBare: false, createdAt: "2026-01-02T00:00:00.000Z" },
      { name: "new", path: "/repo/wt/new", branch: "new", isBare: false, createdAt: "2026-01-03T00:00:00.000Z" },
    ],
  },
  ({ projectRoot, worktrees }) => ({ paths: dashboardWorktreeOrderPaths(projectRoot, worktrees) }),
);

record(
  "dashboard worktree order falls back to tmux index",
  "dashboardWorktreeOrderPaths",
  {
    projectRoot: "/repo",
    worktrees: [
      { name: "repo", path: "/repo", branch: "master", isBare: false, createdAt: "" },
      { name: "later-index", path: "/repo/wt/later-index", branch: "later", isBare: false, tmuxWindowIndex: 9 },
      { name: "earlier-index", path: "/repo/wt/earlier-index", branch: "earlier", isBare: false, index: 2 },
    ],
  },
  ({ projectRoot, worktrees }) => ({ paths: dashboardWorktreeOrderPaths(projectRoot, worktrees) }),
);

record(
  "assigns stable tones by worktree identity",
  "assignWorktreeTones",
  {
    projectRoot: "/p",
    items: [
      item("a", { worktreePath: "/p/a" }),
      item("b", { worktreePath: "/p/b" }),
      item("a2", { worktreePath: "/p/a" }),
    ],
  },
  ({ items, projectRoot }) => ({ tones: tonesObject(assignWorktreeTones(items, projectRoot)) }),
);

record(
  "builds tile contexts for no sublabel worktree and project worktree",
  "exposeTileContextForItem",
  {
    projectRoot: "/p",
    items: [
      item("none", { projectName: "alpha", projectRoot: "/p", worktreePath: "/p/a" }),
      item("worktree", { projectName: "alpha", projectRoot: "/p", worktreePath: "/p/a" }),
      item("project-worktree", { projectName: "alpha", projectRoot: "/p", worktreePath: "/p/a" }),
    ],
    sublabels: ["none", "worktree", "project-worktree"],
  },
  ({ items, projectRoot, sublabels }) => {
    const tones = assignWorktreeTones(items, projectRoot);
    return {
      contexts: sublabels.map((sublabel, index) =>
        exposeTileContextForItem(items[index], sublabel, projectRoot, tones),
      ),
    };
  },
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-07T00:00:00.000Z",
  generatedBy: "scripts/capture-expose-ordering-contract.mjs",
  source: "src/tmux/expose-ordering.ts",
  subject: "src/tmux/expose-ordering.ts",
  description: "Expose ordering, grouping, worktree labels, tones, and tile context captured by running TypeScript.",
  caseCount: cases.length,
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
