#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/runtime-topology/worktrees.json", ROOT);
const NOW = "2026-05-25T00:00:00.000Z";
const LATER = "2026-05-25T01:00:00.000Z";
const LATEST = "2026-05-25T02:00:00.000Z";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};
const recordCase = (name, api, input, output) => ({
  id: `runtime-topology-worktrees-${String(cases.length + 1).padStart(3, "0")}`,
  name,
  source: "src/runtime-core/topology-worktrees.test.ts",
  api,
  input,
  output,
  inputSha256: hash(input),
});

const paths = await import(new URL("dist/paths.js", ROOT));
const storeModule = await import(new URL("dist/runtime-core/topology-store.js", ROOT));
const worktrees = await import(new URL("dist/runtime-core/topology-worktrees.js", ROOT));

function normalize(value, repoRoot) {
  const worktreeIds = new Map();
  const graveyardIds = new Map();
  const token = (map, prefix, text) => {
    if (!map.has(text)) map.set(text, `<${prefix}:${map.size + 1}>`);
    return map.get(text);
  };
  return JSON.parse(
    JSON.stringify(value, (_key, nested) => {
      if (typeof nested !== "string") return nested;
      if (nested.startsWith("worktree-graveyard:")) return token(graveyardIds, "worktree-graveyard-id", nested);
      if (nested.startsWith("worktree:")) return token(worktreeIds, "worktree-id", nested);
      return nested.replaceAll(repoRoot, "<repo>").replaceAll(tmpdir(), "<tmp>");
    }),
  );
}

async function withProject(fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), "aimux-topology-worktrees-"));
  mkdirSync(join(repoRoot, ".git"), { recursive: true });
  await paths.initPaths(repoRoot);
  const store = storeModule.createRuntimeTopologyStore(join(repoRoot, ".aimux", "runtime-topology.yaml"));
  try {
    return normalize(await fn({ repoRoot, store }), repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

async function addCase(name, api, makeInput, run) {
  const output = await withProject((ctx) => run(ctx, makeInput(ctx.repoRoot)));
  cases.push(recordCase(name, api, makeInput("<repo>"), output));
}

const cases = [];

await addCase(
  "tracks active worktrees in topology",
  "upsert-list",
  (repoRoot) => ({ worktree: { path: join(repoRoot, "../feature-a"), name: "feature-a", branch: "feature-a", basePath: repoRoot, createdAt: NOW }, status: "active" }),
  ({ store, repoRoot }, input) => {
    worktrees.upsertTopologyWorktree(input.worktree, input.status, { store, projectRoot: repoRoot, now: NOW });
    return { active: worktrees.listTopologyWorktreeStates({ statuses: ["active"], store }) };
  },
);

await addCase(
  "moves worktrees to topology graveyard without deleting the authority record",
  "move-graveyard",
  (repoRoot) => ({ worktree: { path: join(repoRoot, "../feature-b"), name: "feature-b", branch: "feature-b" }, reason: "user-requested" }),
  ({ store, repoRoot }, input) => {
    worktrees.upsertTopologyWorktree(input.worktree, "active", { store, projectRoot: repoRoot, now: NOW });
    const moved = worktrees.moveTopologyWorktreeToGraveyard(input.worktree.path, { store, projectRoot: repoRoot, now: LATER, reason: input.reason });
    return {
      moved,
      graveyardStates: worktrees.listTopologyWorktreeStates({ statuses: ["graveyard"], store }),
      graveyardPaths: [...worktrees.listTopologyWorktreeGraveyardPaths({ store })],
    };
  },
);

await addCase(
  "marks graveyard entries deleted while preserving audit history",
  "delete-graveyard-entry",
  (repoRoot) => ({ worktree: { path: join(repoRoot, "../feature-c"), name: "feature-c" } }),
  ({ store, repoRoot }, input) => {
    worktrees.upsertTopologyWorktree(input.worktree, "active", { store, projectRoot: repoRoot, now: NOW });
    worktrees.moveTopologyWorktreeToGraveyard(input.worktree.path, { store, projectRoot: repoRoot, now: LATER });
    const deleted = worktrees.deleteTopologyWorktreeGraveyardEntry(input.worktree.path, { store, now: LATEST });
    return {
      deleted,
      visibleGraveyard: worktrees.listTopologyWorktreeGraveyard({ store }),
      allGraveyard: worktrees.listTopologyWorktreeGraveyard({ store, includeDeleted: true }),
    };
  },
);

await addCase(
  "resurrects topology graveyard entries back to active worktrees",
  "resurrect-graveyard-entry",
  (repoRoot) => ({ worktree: { path: join(repoRoot, "../feature-resurrect"), name: "feature-resurrect" } }),
  ({ store, repoRoot }, input) => {
    worktrees.upsertTopologyWorktree(input.worktree, "active", { store, projectRoot: repoRoot, now: NOW });
    worktrees.moveTopologyWorktreeToGraveyard(input.worktree.path, { store, projectRoot: repoRoot, now: LATER });
    const resurrected = worktrees.resurrectTopologyWorktreeFromGraveyard(input.worktree.path, { store, projectRoot: repoRoot, now: LATEST });
    return {
      resurrected,
      graveyard: worktrees.listTopologyWorktreeGraveyard({ store }),
      active: worktrees.listTopologyWorktreeStates({ statuses: ["active"], store }),
    };
  },
);

await addCase(
  "removes active worktree topology without creating graveyard state",
  "remove-worktree",
  (repoRoot) => ({ worktree: { path: join(repoRoot, "../feature-d"), name: "feature-d" } }),
  ({ store, repoRoot }, input) => {
    worktrees.upsertTopologyWorktree(input.worktree, "active", { store, projectRoot: repoRoot, now: NOW });
    const removed = worktrees.removeTopologyWorktree(input.worktree.path, { store, now: LATER });
    return {
      removed,
      worktrees: worktrees.listTopologyWorktreeStates({ store }),
      graveyard: worktrees.listTopologyWorktreeGraveyard({ store }),
    };
  },
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/runtime-core/topology-worktrees.test.ts",
  generatedBy: "scripts/capture-runtime-topology-worktrees-contract.mjs",
  description: "Runtime topology worktree lifecycle and graveyard contracts captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
