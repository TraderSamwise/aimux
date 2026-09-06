#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/runtime-topology/store.json", ROOT);
const NOW = "2026-05-25T00:00:00.000Z";

const topologyStore = await import(new URL("dist/runtime-core/topology-store.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};
const recordCase = (index, name, api, input, output) => ({
  id: `runtime-topology-store-${String(index + 1).padStart(3, "0")}`,
  name,
  source: "src/runtime-core/topology-store.test.ts",
  api,
  input,
  output,
  inputSha256: hash(input),
});

function capture(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), "aimux-runtime-topology-contract-"));
  try {
    const path = join(dir, "runtime-topology.yaml");
    return fn(new topologyStore.RuntimeTopologyStore(path), path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function baseTopology() {
  return topologyStore.emptyRuntimeTopology(NOW);
}

function singleSessionTopology() {
  return {
    ...baseTopology(),
    rigs: [{ id: "rig-main", name: "aimux", projectRoot: "/repo", createdAt: NOW, updatedAt: NOW }],
    nodes: [
      {
        id: "node-codex-1",
        rigId: "rig-main",
        logicalId: "codex-1",
        runtime: "codex",
        toolConfigKey: "codex",
        cwd: "/repo",
        label: "coder",
        createdAt: NOW,
      },
    ],
    sessions: [
      {
        id: "codex-1",
        nodeId: "node-codex-1",
        status: "running",
        tool: "codex",
        command: "codex",
        args: ["-C", "/repo"],
        backendSessionId: "backend-1",
        worktreePath: "/repo",
        team: { name: "reviewers", role: "reviewer", members: ["codex-1"] },
        createdAt: NOW,
        updatedAt: NOW,
        lastSeenAt: NOW,
      },
    ],
  };
}

function fullTopology() {
  return {
    ...singleSessionTopology(),
    bindings: [
      {
        id: "binding-codex-1",
        nodeId: "node-codex-1",
        tmuxSession: "aimux-repo",
        tmuxWindowId: "@1",
        tmuxWindowIndex: 1,
        tmuxWindowName: "codex",
        updatedAt: NOW,
      },
    ],
    services: [
      {
        id: "service-web",
        rigId: "rig-main",
        status: "running",
        command: "zsh",
        args: ["-lc", "yarn web"],
        launchCommandLine: "yarn web",
        worktreePath: "/repo",
        label: "web",
        createdAt: NOW,
        updatedAt: NOW,
        lastSeenAt: NOW,
      },
    ],
    worktrees: [
      {
        id: "worktree-main",
        rigId: "rig-main",
        path: "/repo",
        name: "aimux",
        status: "active",
        branch: "master",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    worktreeGraveyard: [
      {
        id: "graveyard-old",
        rigId: "rig-main",
        worktreeId: "worktree-main",
        path: "/repo-old",
        name: "old",
        graveyardedAt: NOW,
      },
    ],
    teamRoles: [
      {
        id: "role-coder",
        rigId: "rig-main",
        nodeId: "node-codex-1",
        role: "coder",
        label: "Coder",
        order: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    remoteClients: [
      {
        id: "client-sam",
        rigId: "rig-main",
        userId: "sam",
        status: "online",
        connectedAt: NOW,
        lastSeenAt: NOW,
        ownsSessionIds: ["codex-1"],
      },
    ],
    lifecycleOperations: [
      {
        id: "op-stop-codex",
        rigId: "rig-main",
        kind: "agent.stop",
        status: "pending",
        targetKind: "session",
        targetId: "codex-1",
        startedAt: NOW,
        updatedAt: NOW,
      },
    ],
    exchangeRefs: [
      {
        id: "exchange-task-1",
        rigId: "rig-main",
        kind: "task",
        exchangeId: "task-1",
        nodeId: "node-codex-1",
        sessionId: "codex-1",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  };
}

function prunedTopology() {
  return {
    ...baseTopology(),
    rigs: [{ id: "rig-main", name: "repo", projectRoot: "/repo", createdAt: NOW, updatedAt: NOW }],
    nodes: [{ id: "agent:keep", rigId: "rig-main", logicalId: "keep", createdAt: NOW }],
    sessions: [{ id: "keep", nodeId: "agent:keep", status: "offline", createdAt: NOW, updatedAt: NOW }],
    services: [
      { id: "service-keep", rigId: "rig-main", status: "running", createdAt: NOW, updatedAt: NOW },
      { id: "service-drop", rigId: "missing-rig", status: "running", createdAt: NOW, updatedAt: NOW },
    ],
    worktrees: [
      { id: "worktree-keep", rigId: "rig-main", path: "/repo", name: "repo", status: "active", createdAt: NOW, updatedAt: NOW },
      { id: "worktree-drop", rigId: "missing-rig", path: "/repo/drop", name: "drop", status: "active", createdAt: NOW, updatedAt: NOW },
    ],
    worktreeGraveyard: [
      { id: "graveyard-keep", rigId: "rig-main", worktreeId: "worktree-keep", path: "/repo-old", graveyardedAt: NOW },
      { id: "graveyard-drop", rigId: "rig-main", worktreeId: "worktree-drop", path: "/repo-drop", graveyardedAt: NOW },
    ],
    teamRoles: [
      { id: "role-keep", rigId: "rig-main", nodeId: "agent:keep", role: "coder", createdAt: NOW, updatedAt: NOW },
      { id: "role-drop", rigId: "rig-main", nodeId: "agent:drop", role: "coder", createdAt: NOW, updatedAt: NOW },
    ],
    remoteClients: [{ id: "client-keep", rigId: "rig-main", status: "online", lastSeenAt: NOW, ownsSessionIds: ["keep", "drop"] }],
    lifecycleOperations: [
      { id: "op-keep", rigId: "rig-main", kind: "agent.stop", status: "pending", targetKind: "session", targetId: "keep", startedAt: NOW, updatedAt: NOW },
      { id: "op-drop", rigId: "rig-main", kind: "service.stop", status: "pending", targetKind: "service", targetId: "service-drop", startedAt: NOW, updatedAt: NOW },
    ],
    exchangeRefs: [
      { id: "exchange-keep", rigId: "rig-main", kind: "task", exchangeId: "task-1", sessionId: "keep", createdAt: NOW, updatedAt: NOW },
      { id: "exchange-drop", rigId: "rig-main", kind: "task", exchangeId: "task-2", sessionId: "drop", createdAt: NOW, updatedAt: NOW },
    ],
  };
}

const badLifecycleYaml = [
  "version: 1",
  `generatedAt: ${NOW}`,
  "rigs:",
  "  - id: rig-main",
  "    name: repo",
  "    projectRoot: /repo",
  `    createdAt: ${NOW}`,
  `    updatedAt: ${NOW}`,
  "nodes: []",
  "edges: []",
  "bindings: []",
  "sessions: []",
  "services: []",
  "worktrees: []",
  "worktreeGraveyard: []",
  "teamRoles: []",
  "remoteClients: []",
  "lifecycleOperations:",
  "  - id: op-bad",
  "    rigId: rig-main",
  "    kind: agent.stop",
  "    status: pending",
  "    targetKind: bogus",
  "    targetId: rig-main",
  `    startedAt: ${NOW}`,
  `    updatedAt: ${NOW}`,
  "exchangeRefs: []",
  "",
].join("\n");

const badExchangeYaml = [
  "version: 1",
  `generatedAt: ${NOW}`,
  "rigs:",
  "  - id: rig-main",
  "    name: repo",
  "    projectRoot: /repo",
  `    createdAt: ${NOW}`,
  `    updatedAt: ${NOW}`,
  "nodes: []",
  "edges: []",
  "bindings: []",
  "sessions: []",
  "services: []",
  "worktrees: []",
  "worktreeGraveyard: []",
  "teamRoles: []",
  "remoteClients: []",
  "lifecycleOperations: []",
  "exchangeRefs:",
  "  - id: exchange-bad",
  "    rigId: rig-main",
  "    kind: bogus",
  "    exchangeId: item-1",
  `    createdAt: ${NOW}`,
  `    updatedAt: ${NOW}`,
  "",
].join("\n");

const cases = [];
const add = (name, api, input, output) => cases.push(recordCase(cases.length, name, api, input, output));

add("does not share the team object with its caller in either direction", "teamClone", { topology: singleSessionTopology() }, withStore((store) => {
  const topology = singleSessionTopology();
  const originalTeam = structuredClone(topology.sessions[0].team);
  const written = store.write(topology);
  topology.sessions[0].team.name = "caller-mutated";
  const first = store.read();
  first.sessions[0].team.name = "read-mutated";
  first.sessions[0].team.members.push("injected");
  return {
    writtenTeam: written.sessions[0].team,
    firstTeamBeforeMutation: originalTeam,
    rereadTeam: store.read().sessions[0].team,
  };
}));

add("never lets a caller's mutation leak into a later read", "readIsolation", { topology: fullTopology() }, withStore((store) => {
  store.write(fullTopology());
  const pristine = structuredClone(store.read());
  const mutated = store.read();
  mutated.sessions[0].args.push("injected");
  mutated.sessions[0].command = "clobbered";
  mutated.services[0].args.push("injected");
  mutated.worktrees[0].path = "/clobbered";
  mutated.nodes[0].cwd = "/clobbered";
  mutated.rigs[0].name = "clobbered";
  mutated.bindings[0].tmuxSession = "clobbered";
  mutated.lifecycleOperations[0].targetId = "clobbered";
  mutated.exchangeRefs[0].exchangeId = "clobbered";
  return { pristine, reread: store.read(), equal: JSON.stringify(store.read()) === JSON.stringify(pristine) };
}));

add("serves a rewritten file rather than a cached parse", "rewrittenFile", { topology: singleSessionTopology() }, withStore((store, path) => {
  const topology = singleSessionTopology();
  store.write(topology);
  const firstName = store.read().rigs[0].name;
  const before = readFileSync(path, "utf-8");
  const after = before.replace("name: aimux", "name: aimuz");
  writeFileSync(path, after);
  const secondName = store.read().rigs[0].name;
  rmSync(path, { force: true });
  return { firstName, secondName, afterDeleteRigCount: store.read().rigs.length, sameLength: before.length === after.length };
}));

add("round-trips the OpenRig-style runtime topology YAML", "writeRead", { topology: fullTopology() }, withStore((store) => capture(() => store.write(fullTopology()))));
add("rejects corrupt topology YAML instead of silently resetting runtime truth", "readYaml", { yaml: "version: nope\n" }, withStore((store, path) => {
  writeFileSync(path, "version: nope\n");
  return capture(() => store.read());
}));
add("rejects unsupported lifecycle target kinds instead of remapping them", "readYaml", { yaml: badLifecycleYaml }, withStore((store, path) => {
  writeFileSync(path, badLifecycleYaml);
  return capture(() => store.read());
}));
add("rejects unsupported exchange reference kinds instead of remapping them", "readYaml", { yaml: badExchangeYaml }, withStore((store, path) => {
  writeFileSync(path, badExchangeYaml);
  return capture(() => store.read());
}));
add("serializes update with a filesystem lock and releases it after writing", "updateLock", { topology: singleSessionTopology() }, withStore((store, path) => {
  const updated = store.update((topology) => ({
    ...topology,
    rigs: singleSessionTopology().rigs,
    nodes: singleSessionTopology().nodes,
    sessions: singleSessionTopology().sessions,
  }));
  return { lockExists: existsSync(`${path}.lock`), sessions: updated.sessions.map((session) => session.id) };
}));
add("reclaims a stale lock left behind by a dead owner instead of timing out", "staleLock", {}, withStore((store, path) => {
  const lockPath = `${path}.lock`;
  mkdirSync(lockPath);
  writeFileSync(join(lockPath, "owner"), "2147483647\n");
  const past = new Date(Date.now() - 10_000);
  utimesSync(lockPath, past, past);
  const updated = store.update((topology) => topology);
  return { lockExists: existsSync(lockPath), version: updated.version };
}));
add("prunes extended topology references to missing rigs, nodes, sessions, services, and worktrees", "writeRead", { topology: prunedTopology() }, withStore((store) => capture(() => store.write(prunedTopology()))));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/runtime-core/topology-store.test.ts",
  generatedBy: "scripts/capture-runtime-topology-store-contract.mjs",
  description: "Runtime topology store clone, cache invalidation, YAML read/write, lock, validation, and reference-pruning contracts captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
