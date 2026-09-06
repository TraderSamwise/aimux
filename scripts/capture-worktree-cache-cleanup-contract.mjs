#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/worktree/cache-cleanup.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};
const recordCase = (index, name, api, input, output) => ({
  id: `worktree-cache-cleanup-${String(index + 1).padStart(3, "0")}`,
  name,
  source: "src/worktree-cache-cleanup.test.ts",
  api,
  input,
  output,
  inputSha256: hash(input),
});

const paths = await import(new URL("dist/paths.js", ROOT));
const topologySessions = await import(new URL("dist/runtime-core/topology-sessions.js", ROOT));
const topologyServices = await import(new URL("dist/runtime-core/topology-services.js", ROOT));
const cleanup = await import(new URL("dist/worktree-cache-cleanup.js", ROOT));

function writeCache(path) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "payload.txt"), "cache\n");
}

function normalize(value, ctx) {
  return JSON.parse(
    JSON.stringify(value, (_key, nested) => {
      if (typeof nested !== "string") return nested;
      return nested.replaceAll(ctx.projectRoot, "<repo>");
    }),
  );
}

async function withFixture(label, fn) {
  const tmpRoot = mkdtempSync(join(tmpdir(), `aimux-worktree-cache-contract-${label}-`));
  mkdirSync(join(tmpRoot, "repo", ".aimux", "worktrees"), { recursive: true });
  const projectRoot = realpathSync(join(tmpRoot, "repo"));
  const worktreeRoot = realpathSync(join(projectRoot, ".aimux", "worktrees"));
  const previousHome = process.env.AIMUX_HOME;
  process.env.AIMUX_HOME = join(tmpRoot, "home");
  try {
    await paths.initPaths(projectRoot);
    const ctx = { tmpRoot, projectRoot, worktreeRoot };
    return normalize(await fn(ctx), ctx);
  } finally {
    if (previousHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previousHome;
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

const cases = [];
const add = async (name, scenario, api, fn) => {
  const input = { scenario };
  cases.push(recordCase(cases.length, name, api, input, await withFixture(scenario, fn)));
};

await add("plans nested cache directories in Aimux-managed worktrees", "nested-plan", "runWorktreeCacheCleanup", ({ projectRoot, worktreeRoot }) => {
  const worktreePath = join(worktreeRoot, "perf");
  writeCache(join(worktreePath, "node_modules"));
  writeCache(join(worktreePath, "apps", "web", ".next"));
  return cleanup.runWorktreeCacheCleanup({
    projectRoot,
    worktreeBaseDir: worktreeRoot,
    worktrees: [
      { name: "repo", branch: "master", path: projectRoot, isBare: false },
      { name: "perf", branch: "perf", path: worktreePath, isBare: false },
    ],
  });
});

await add("skips worktrees with active agents or services by default", "active-runtime-skip", "runWorktreeCacheCleanup", ({ projectRoot, worktreeRoot }) => {
  const worktreePath = join(worktreeRoot, "live");
  writeCache(join(worktreePath, "node_modules"));
  topologySessions.upsertTopologySession({ id: "codex-live", tool: "codex", command: "codex", args: [], worktreePath }, "idle", { projectRoot });
  topologyServices.upsertTopologyService({ id: "web", command: "yarn", worktreePath }, "starting", { projectRoot });
  return cleanup.runWorktreeCacheCleanup({
    projectRoot,
    worktreeBaseDir: worktreeRoot,
    worktrees: [{ name: "live", branch: "live", path: worktreePath, isBare: false }],
  });
});

await add("removes planned cache directories only when dry run is disabled", "dry-run-then-delete", "runWorktreeCacheCleanup", ({ projectRoot, worktreeRoot }) => {
  const worktreePath = join(worktreeRoot, "old");
  const cachePath = join(worktreePath, "apps", "web", ".next");
  writeCache(cachePath);
  const dryRun = cleanup.runWorktreeCacheCleanup({
    projectRoot,
    worktreeBaseDir: worktreeRoot,
    worktrees: [{ name: "old", branch: "old", path: worktreePath, isBare: false }],
  });
  const dryRunCacheExists = existsSync(cachePath);
  const deleted = cleanup.runWorktreeCacheCleanup({
    projectRoot,
    worktreeBaseDir: worktreeRoot,
    dryRun: false,
    worktrees: [{ name: "old", branch: "old", path: worktreePath, isBare: false }],
  });
  return { dryRun, dryRunCacheExists, deleted, deletedCacheExists: existsSync(cachePath) };
});

await add("ignores configured cleanup names outside the generated-cache allowlist", "unsafe-config", "runWorktreeCacheCleanup", ({ projectRoot, worktreeRoot }) => {
  const worktreePath = join(worktreeRoot, "unsafe-config");
  const sourcePath = join(worktreePath, "src");
  const cachePath = join(worktreePath, "node_modules");
  writeCache(sourcePath);
  writeCache(cachePath);
  const deleted = cleanup.runWorktreeCacheCleanup({
    projectRoot,
    worktreeBaseDir: worktreeRoot,
    dryRun: false,
    cacheDirNames: ["src", "node_modules"],
    worktrees: [{ name: "unsafe-config", branch: "unsafe-config", path: worktreePath, isBare: false }],
  });
  return { deleted, cacheExists: existsSync(cachePath), sourceExists: existsSync(sourcePath) };
});

await add("renders large cleanup results as a summarized report", "render-large-report", "renderWorktreeCacheCleanupRunResult", ({ worktreeRoot }) => {
  const result = {
    dryRun: true,
    reclaimedBytes: 0,
    plan: {
      projectRoot: "<repo>",
      dryRun: true,
      includeActive: false,
      cacheDirNames: ["node_modules", ".next"],
      reclaimableBytes: 4096,
      skipped: [{ worktreePath: join(worktreeRoot, "live"), reason: "active-runtime" }],
      targets: Array.from({ length: 25 }, (_, index) => ({
        worktreePath: join(worktreeRoot, index % 2 === 0 ? "alpha" : "beta"),
        relativePath: `pkg-${index}/node_modules`,
        path: join(worktreeRoot, index % 2 === 0 ? "alpha" : "beta", `pkg-${index}`, "node_modules"),
        sizeBytes: index % 2 === 0 ? 256 : 128,
      })),
    },
    results: [],
  };
  return cleanup.renderWorktreeCacheCleanupRunResult(result);
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/worktree-cache-cleanup.test.ts",
  generatedBy: "scripts/capture-worktree-cache-cleanup-contract.mjs",
  description: "Worktree cache cleanup plan, apply, safety allowlist, active-runtime skip, and report rendering contracts captured by running TypeScript cleanup helpers.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
