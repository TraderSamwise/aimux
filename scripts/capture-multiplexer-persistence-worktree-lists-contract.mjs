#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/persistence-worktree-lists.json", ROOT);
const FIXED_NOW = "2026-06-01T00:00:00.000Z";
const RealDate = Date;

globalThis.Date = class FixedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) return new RealDate(FIXED_NOW);
    return new RealDate(...args);
  }

  static now() {
    return new RealDate(FIXED_NOW).getTime();
  }

  static parse(value) {
    return RealDate.parse(value);
  }

  static UTC(...args) {
    return RealDate.UTC(...args);
  }
};

const { DashboardPendingActions } = await import(new URL("dist/dashboard/pending-actions.js", ROOT));
const { initPaths } = await import(new URL("dist/paths.js", ROOT));
const { persistenceMethods } = await import(new URL("dist/multiplexer/persistence-methods.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function git(cwd, args) {
  execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    stdio: "pipe",
  });
}

async function createRepo() {
  const root = await mkdtemp(join(tmpdir(), "aimux-worktree-list-"));
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  git(repo, ["init", "-b", "master"]);
  await writeFile(join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["-c", "user.name=Aimux Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "seed"]);
  const worktree = join(repo, ".aimux", "worktrees", "demo");
  await mkdir(join(repo, ".aimux", "worktrees"), { recursive: true });
  git(repo, ["worktree", "add", worktree, "-b", "demo"]);
  return { root, repo: await realpath(repo), worktree: await realpath(worktree) };
}

function normalizePaths(value, repo, worktree) {
  if (typeof value === "string") {
    return value.split(worktree).join("/repo/.aimux/worktrees/demo").split(repo).join("/repo");
  }
  if (Array.isArray(value)) return value.map((entry) => normalizePaths(entry, repo, worktree));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = normalizePaths(child, repo, worktree);
  }
  if (out.createdAt && out.path === "/repo") out.createdAt = "<createdAt:main>";
  if (out.createdAt && out.path === "/repo/.aimux/worktrees/demo") out.createdAt = "<createdAt:demo>";
  return out;
}

function denormalizePaths(value, repo, worktree) {
  if (typeof value === "string") {
    if (value === "/repo/.aimux/worktrees/demo") return worktree;
    if (value.startsWith("/repo/.aimux/worktrees/demo/")) {
      return `${worktree}${value.slice("/repo/.aimux/worktrees/demo".length)}`;
    }
    if (value === "/repo") return repo;
    if (value.startsWith("/repo/")) return `${repo}${value.slice("/repo".length)}`;
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => denormalizePaths(entry, repo, worktree));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, denormalizePaths(child, repo, worktree)]));
}

function applyPending(pending, actions) {
  for (const action of actions ?? []) {
    if (action.target === "worktree") pending.setWorktreeAction(action.path, action.kind, clone(action.opts ?? {}));
  }
}

async function run(input) {
  const { root, repo, worktree } = await createRepo();
  const aimuxHome = await mkdtemp(join(tmpdir(), "aimux-home-"));
  const previousAimuxHome = process.env.AIMUX_HOME;
  process.env.AIMUX_HOME = aimuxHome;
  try {
    await initPaths(repo);
    const pending = new DashboardPendingActions(() => {});
    const actualActions = (input.host.pendingActions ?? []).map((action) => denormalizePaths(action, repo, worktree));
    applyPending(pending, actualActions);
    const host = {
      projectRoot: repo,
      dashboardPendingActions: pending,
      pendingWorktreeRemovals: new Map(
        actualActions.map((action) => [action.path, Promise.resolve({ path: action.path, status: "removed" })]),
      ),
    };
    if (input.api === "listDesktopWorktrees") {
      return normalizePaths({ returned: persistenceMethods.listDesktopWorktrees.call(host) }, repo, worktree);
    }
    if (input.api === "listProjectedDesktopWorktrees") {
      host.listDesktopWorktrees = () => persistenceMethods.listDesktopWorktrees.call(host);
      return normalizePaths({ returned: persistenceMethods.listProjectedDesktopWorktrees.call(host) }, repo, worktree);
    }
    throw new Error(`unknown api ${input.api}`);
  } finally {
    if (previousAimuxHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previousAimuxHome;
    await rm(root, { recursive: true, force: true });
    await rm(aimuxHome, { recursive: true, force: true });
  }
}

const pendingRemoval = {
  target: "worktree",
  path: "/repo/.aimux/worktrees/demo",
  kind: "removing",
};

const inputs = [
  {
    name: "keeps raw worktree lists free of pending removal state",
    api: "listDesktopWorktrees",
    host: { pendingActions: [pendingRemoval] },
  },
  {
    name: "projects raw worktree removal state only through projected worktree lists",
    api: "listProjectedDesktopWorktrees",
    host: { pendingActions: [pendingRemoval] },
  },
];

const cases = [];
for (const [index, input] of inputs.entries()) {
  const output = await run(input);
  cases.push({
    id: `multiplexer-persistence-worktree-lists-${String(index + 1).padStart(3, "0")}`,
    name: input.name,
    source: "src/multiplexer/persistence-methods.test.ts",
    api: input.api,
    input,
    output,
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/persistence-methods.test.ts",
  generatedBy: "scripts/capture-multiplexer-persistence-worktree-lists-contract.mjs",
  description:
    "Persistence raw and projected worktree-list behavior captured by running TypeScript against a disposable git worktree.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
