#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/project-topology/topology.json", ROOT);
const topology = await import(new URL("dist/project-topology.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

const cases = [];
function record(name, api, input, output) {
  cases.push({
    id: `project-topology-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/project-topology.test.ts",
    api,
    input,
    output,
    inputSha256: hash(input),
  });
}

for (const [status, pendingAction] of [
  ["running", undefined],
  ["waiting", undefined],
  ["idle", undefined],
  ["offline", undefined],
  ["exited", undefined],
  ["running", "stopping"],
  [undefined, undefined],
]) {
  record("maps status and pending action to health", "healthForStatus", { status, pendingAction }, topology.healthForStatus(status, pendingAction));
}

for (const healths of [[], ["offline", "idle"], ["idle", "active"], ["active", "attention"], ["offline", "offline"]]) {
  record("rolls child health up by priority", "rollupHealth", { healths }, topology.rollupHealth(healths));
}

record(
  "builds worktree views flattened rows counts and rolled-up health",
  "buildProjectTopology",
  {
    projectName: "aimux",
    worktrees: [
      {
        name: "main",
        branch: "master",
        path: "/repo",
        status: "active",
        sessions: [
          { id: "a1", command: "claude", label: "coder", role: "coder", status: "running" },
          { id: "a2", command: "codex", status: "waiting" },
        ],
        services: [{ id: "s1", command: "yarn dev", label: "web", status: "running" }],
      },
      {
        name: "wt-x",
        branch: "feat/x",
        path: "/repo/wt-x",
        status: "offline",
        sessions: [{ id: "a3", command: "claude", status: "offline" }],
        services: [],
      },
    ],
  },
  topology.buildProjectTopology({
    projectName: "aimux",
    worktrees: [
      {
        name: "main",
        branch: "master",
        path: "/repo",
        status: "active",
        sessions: [
          { id: "a1", command: "claude", label: "coder", role: "coder", status: "running" },
          { id: "a2", command: "codex", status: "waiting" },
        ],
        services: [{ id: "s1", command: "yarn dev", label: "web", status: "running" }],
      },
      {
        name: "wt-x",
        branch: "feat/x",
        path: "/repo/wt-x",
        status: "offline",
        sessions: [{ id: "a3", command: "claude", status: "offline" }],
        services: [],
      },
    ],
  }),
);

record(
  "treats pending and removing worktree health specially",
  "buildProjectTopology",
  {
    projectName: "aimux",
    worktrees: [
      { name: "creating", branch: "feat/new", pending: true, sessions: [], services: [] },
      {
        name: "dying",
        branch: "feat/old",
        removing: true,
        sessions: [{ id: "x", command: "claude", status: "running" }],
        services: [],
      },
    ],
  },
  topology.buildProjectTopology({
    projectName: "aimux",
    worktrees: [
      { name: "creating", branch: "feat/new", pending: true, sessions: [], services: [] },
      {
        name: "dying",
        branch: "feat/old",
        removing: true,
        sessions: [{ id: "x", command: "claude", status: "running" }],
        services: [],
      },
    ],
  }),
);

record(
  "handles an empty project",
  "buildProjectTopology",
  { projectName: "empty", worktrees: [] },
  topology.buildProjectTopology({ projectName: "empty", worktrees: [] }),
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/project-topology.test.ts",
  generatedBy: "scripts/capture-project-topology-contract.mjs",
  description:
    "Project topology health, rollup, worktree view, flattened row, and count contracts captured by running TypeScript project-topology helpers.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
