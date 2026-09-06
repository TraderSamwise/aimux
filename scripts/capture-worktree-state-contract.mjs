#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/worktree/state.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function normalize(value, replacements) {
  return JSON.parse(
    JSON.stringify(value, (_key, nested) => {
      if (typeof nested !== "string") return nested;
      let out = nested;
      for (const [from, to] of replacements) out = out.replaceAll(from, to);
      return out;
    }),
  );
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

function makeRepo(label) {
  const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), `aimux-worktree-state-${label}-`)));
  const repoRoot = join(tmpRoot, "repo");
  mkdirSync(repoRoot, { recursive: true });
  git(["init", "-q"], repoRoot);
  git(["config", "user.email", "fixture@example.com"], repoRoot);
  git(["config", "user.name", "Fixture"], repoRoot);
  writeFileSync(join(repoRoot, "README.md"), "fixture\n");
  git(["add", "README.md"], repoRoot);
  git(["commit", "-q", "-m", "fixture"], repoRoot);
  return { tmpRoot, repoRoot: realpathSync(repoRoot) };
}

const paths = await import(new URL("dist/paths.js", ROOT));
const worktree = await import(new URL("dist/worktree.js", ROOT));
const topologySessions = await import(new URL("dist/runtime-core/topology-sessions.js", ROOT));
const topologyServices = await import(new URL("dist/runtime-core/topology-services.js", ROOT));
const topologyWorktrees = await import(new URL("dist/runtime-core/topology-worktrees.js", ROOT));
const graveyard = await import(new URL("dist/multiplexer/worktree-graveyard.js", ROOT));
const graveyardView = await import(new URL("dist/multiplexer/graveyard-view-model.js", ROOT));

async function withRepo(label, fn) {
  const { tmpRoot, repoRoot } = makeRepo(label);
  const previousHome = process.env.AIMUX_HOME;
  process.env.AIMUX_HOME = join(tmpRoot, "home");
  try {
    await paths.initPaths(repoRoot);
    const output = await fn({ tmpRoot, repoRoot });
    return normalize(output, [
      [repoRoot, "<repo>"],
      [tmpRoot, "<tmp>"],
    ]);
  } finally {
    if (previousHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previousHome;
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function session(input) {
  return { tool: "codex", toolConfigKey: "codex", command: "codex", args: [], ...input };
}

function service(input) {
  return { label: "shell", command: "zsh", args: [], ...input };
}

const graveyardViewInputs = [
  {
    name: "uses one selectable action model while displaying attached worktree agents and services",
    api: "buildGraveyardViewModel",
    value: {
      worktrees: [
        {
          name: "demo",
          path: "/repo/.aimux/worktrees/demo",
          branch: "demo",
          graveyardedAt: "2026-05-01T00:00:00.000Z",
          agents: [session({ id: "codex-1", worktreePath: "/repo/.aimux/worktrees/demo" })],
          services: [service({ id: "service-1", worktreePath: "/repo/.aimux/worktrees/demo" })],
        },
      ],
      agents: [session({ id: "claude-1", tool: "claude", worktreePath: "/repo/.aimux/worktrees/demo" })],
      lastUsedById: {
        "codex-1": { lastUsedAt: "2026-05-01T00:00:00.000Z" },
        "claude-1": { lastUsedAt: "2026-05-02T00:00:00.000Z" },
        "service-1": { lastUsedAt: "2026-05-03T00:00:00.000Z" },
      },
    },
  },
  {
    name: "does not render duplicate flat agents already embedded under a graveyarded worktree",
    api: "buildGraveyardViewModel",
    value: {
      worktrees: [
        {
          name: "demo",
          path: "/repo/.aimux/worktrees/demo",
          branch: "demo",
          graveyardedAt: "2026-05-01T00:00:00.000Z",
          agents: [session({ id: "codex-1", worktreePath: "/repo/.aimux/worktrees/demo" })],
        },
      ],
      agents: [session({ id: "codex-1", worktreePath: "/repo/.aimux/worktrees/demo" })],
    },
  },
  {
    name: "groups standalone graveyarded agents by worktree and leaves only missing-path agents orphaned",
    api: "buildGraveyardViewModel",
    value: {
      worktrees: [],
      agents: [
        session({ id: "codex-1", worktreePath: "/repo/.aimux/worktrees/demo" }),
        session({ id: "claude-1", tool: "claude" }),
      ],
      lastUsedById: {
        "codex-1": { lastUsedAt: "2026-05-02T00:00:00.000Z" },
      },
    },
  },
  {
    name: "orders worktrees by most recent attached activity and caps visible attached agents",
    api: "buildGraveyardViewModel",
    value: {
      worktrees: [
        {
          name: "older",
          path: "/repo/.aimux/worktrees/older",
          branch: "older",
          graveyardedAt: "2026-05-01T00:00:00.000Z",
          agents: [session({ id: "older-agent", createdAt: "2026-05-02T00:00:00.000Z" })],
        },
        {
          name: "newer",
          path: "/repo/.aimux/worktrees/newer",
          branch: "newer",
          graveyardedAt: "2026-05-01T00:00:00.000Z",
          agents: Array.from({ length: 7 }, (_, index) =>
            session({ id: `newer-agent-${index}`, tool: "claude", createdAt: `2026-05-01T00:00:0${index}.000Z` }),
          ),
        },
      ],
      agents: [],
      lastUsedById: {
        "older-agent": { lastUsedAt: "2026-05-02T00:00:00.000Z" },
        "newer-agent-0": { lastUsedAt: "2026-05-03T00:00:00.000Z" },
      },
    },
  },
  {
    name: "renders orphan teammates as display-only diagnostic rows",
    api: "buildGraveyardViewModel",
    value: {
      worktrees: [],
      agents: [],
      parentSessions: [session({ id: "parent", tool: "claude" })],
      teammates: [
        session({ id: "attached-teammate", team: { teamId: "team-1", parentSessionId: "parent" } }),
        session({ id: "orphan-teammate", team: { teamId: "team-1", parentSessionId: "missing-parent" } }),
      ],
      lastUsedById: {
        "orphan-teammate": { lastUsedAt: "2026-05-04T00:00:00.000Z" },
      },
    },
  },
  {
    name: "does not mark teammates orphaned when the parent is a graveyard entry or attached to a graveyarded worktree",
    api: "buildGraveyardViewModel",
    value: {
      worktrees: [
        {
          name: "demo",
          path: "/repo/.aimux/worktrees/demo",
          branch: "demo",
          graveyardedAt: "2026-05-01T00:00:00.000Z",
          agents: [session({ id: "attached-parent", tool: "claude", worktreePath: "/repo/.aimux/worktrees/demo" })],
        },
      ],
      agents: [session({ id: "flat-parent", worktreePath: "/repo/.aimux/worktrees/other" })],
      teammates: [
        session({ id: "child-of-attached", team: { teamId: "team-1", parentSessionId: "attached-parent" } }),
        session({ id: "child-of-flat", tool: "claude", team: { teamId: "team-2", parentSessionId: "flat-parent" } }),
      ],
    },
  },
  {
    name: "does not duplicate teammate rows already present in graveyard entries",
    api: "buildGraveyardViewModel",
    value: {
      worktrees: [],
      agents: [
        session({
          id: "graveyarded-teammate",
          worktreePath: "/repo/.aimux/worktrees/demo",
          team: { teamId: "team-1", parentSessionId: "missing-parent" },
        }),
      ],
      teammates: [
        session({
          id: "graveyarded-teammate",
          worktreePath: "/repo/.aimux/worktrees/demo",
          team: { teamId: "team-1", parentSessionId: "missing-parent" },
        }),
      ],
    },
  },
];

async function run(input) {
  switch (input.api) {
    case "getWorktreeCreatePath":
      return withRepo(input.scenario, async ({ repoRoot }) => {
        if (input.config) {
          mkdirSync(join(repoRoot, ".aimux"), { recursive: true });
          writeFileSync(join(repoRoot, ".aimux", "config.json"), JSON.stringify(input.config));
        }
        return { target: worktree.getWorktreeCreatePath(input.worktreeName, repoRoot) };
      });
    case "getWorktreeAddArgs":
      return withRepo(input.scenario, async ({ repoRoot }) => {
        if (input.branchExists) git(["branch", input.branch], repoRoot);
        return { args: worktree.getWorktreeAddArgs(input.branch, input.targetPath, repoRoot) };
      });
    case "isToolInternalWorktree":
      return worktree.isToolInternalWorktree(input.worktree);
    case "listWorktreeGraveyardEntries":
      return withRepo(input.scenario, async ({ repoRoot }) => {
        const worktreePath = join(repoRoot, ".aimux", "worktrees", "demo");
        topologyWorktrees.upsertTopologyWorktree({ path: worktreePath, name: "demo", branch: "demo" }, "active", {
          projectRoot: repoRoot,
          now: "2026-05-01T00:00:00.000Z",
        });
        topologySessions.upsertTopologySession(
          session({ id: "codex-demo", worktreePath }),
          "offline",
          { projectRoot: repoRoot, now: "2026-05-01T00:00:01.000Z" },
        );
        topologyServices.upsertTopologyService(
          service({ id: "service-demo", launchCommandLine: "yarn web", worktreePath }),
          "stopped",
          { projectRoot: repoRoot, now: "2026-05-01T00:00:02.000Z" },
        );
        topologyWorktrees.moveTopologyWorktreeToGraveyard(worktreePath, {
          projectRoot: repoRoot,
          now: "2026-05-01T00:00:03.000Z",
        });
        return graveyard.listWorktreeGraveyardEntries();
      });
    case "buildGraveyardViewModel":
      return graveyardView.buildGraveyardViewModel(input.value);
    default:
      throw new Error(`unknown api ${input.api}`);
  }
}

const inputs = [
  {
    name: "resolves created worktrees under .aimux/worktrees by default",
    source: "src/worktree.test.ts",
    api: "getWorktreeCreatePath",
    scenario: "default-base",
    worktreeName: "fix-auth",
  },
  {
    name: "supports absolute worktree base directories",
    source: "src/worktree.test.ts",
    api: "getWorktreeCreatePath",
    scenario: "absolute-base",
    worktreeName: "fix-auth",
    config: { worktrees: { baseDir: "/tmp/aimux-worktrees" } },
  },
  {
    name: "adds a new branch when the branch is missing",
    source: "src/worktree.test.ts",
    api: "getWorktreeAddArgs",
    scenario: "missing-branch",
    branch: "fix-auth",
    targetPath: "/repo/.aimux/worktrees/fix-auth",
    branchExists: false,
  },
  {
    name: "checks out an existing branch instead of recreating it",
    source: "src/worktree.test.ts",
    api: "getWorktreeAddArgs",
    scenario: "existing-branch",
    branch: "fix-auth",
    targetPath: "/repo/.aimux/worktrees/fix-auth",
    branchExists: true,
  },
  {
    name: "identifies Claude private agent scratch worktrees",
    source: "src/worktree.test.ts",
    api: "isToolInternalWorktree",
    worktree: {
      name: "agent-a79377141defdccc4",
      path: "/repo/.claude/worktrees/agent-a79377141defdccc4",
      branch: "worktree-agent-a79377141defdccc4",
    },
  },
  {
    name: "does not classify named Claude user worktrees as internal",
    source: "src/worktree.test.ts",
    api: "isToolInternalWorktree",
    worktree: {
      name: "desktop-enhancements",
      path: "/repo/.claude/worktrees/desktop-enhancements",
      branch: "worktree-desktop-enhancements",
    },
  },
  {
    name: "includes attached topology sessions and services in graveyard entries",
    source: "src/multiplexer/worktree-graveyard.test.ts",
    api: "listWorktreeGraveyardEntries",
    scenario: "graveyard-projection",
  },
  ...graveyardViewInputs.map((input) => ({ ...input, source: "src/multiplexer/graveyard-view-model.test.ts" })),
];

const cases = [];
for (const input of inputs) {
  cases.push({
    id: `worktree-state-${String(cases.length + 1).padStart(3, "0")}`,
    name: input.name,
    source: input.source,
    api: input.api,
    input,
    output: await run(input),
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: ["src/worktree.test.ts", "src/multiplexer/worktree-graveyard.test.ts", "src/multiplexer/graveyard-view-model.test.ts"],
  generatedBy: "scripts/capture-worktree-state-contract.mjs",
  description:
    "Worktree path, git-argv, internal scratch-worktree, graveyard projection, and graveyard view-model contracts captured by running TypeScript worktree and multiplexer helpers.",
  normalization: {
    paths: {
      repo: "<repo>",
      tmp: "<tmp>",
    },
  },
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
