#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/runtime-topology/services.json", ROOT);
const NOW = "2026-05-25T00:00:00.000Z";
const LATER = "2026-05-25T01:00:00.000Z";
const target = (windowId, windowIndex, windowName) => ({ sessionName: "aimux-repo", windowId, windowIndex, windowName });

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};
const recordCase = (name, api, input, output) => ({
  id: `runtime-topology-services-${String(cases.length + 1).padStart(3, "0")}`,
  name,
  source: "src/runtime-core/topology-services.test.ts",
  api,
  input,
  output,
  inputSha256: hash(input),
});

const paths = await import(new URL("dist/paths.js", ROOT));
const storeModule = await import(new URL("dist/runtime-core/topology-store.js", ROOT));
const services = await import(new URL("dist/runtime-core/topology-services.js", ROOT));

function normalize(value, repoRoot) {
  const rigIds = new Map();
  return JSON.parse(
    JSON.stringify(value, (key, nested) => {
      if (typeof nested !== "string") return nested;
      if (key === "rigId") {
        if (!rigIds.has(nested)) rigIds.set(nested, `<rig:${rigIds.size + 1}>`);
        return rigIds.get(nested);
      }
      return nested.replaceAll(repoRoot, "<repo>");
    }),
  );
}

async function withProject(fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), "aimux-topology-services-"));
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
  "tracks live service state and tmux bindings in topology",
  "upsert-running",
  (repoRoot) => ({
    service: {
      id: "service-web",
      command: "zsh",
      args: ["-lc", "yarn web"],
      launchCommandLine: "yarn web",
      worktreePath: repoRoot,
      cwd: repoRoot,
      label: "web",
      tmuxTarget: target("@2", 2, "web"),
    },
  }),
  ({ store, repoRoot }, input) => {
    services.upsertTopologyService(input.service, "running", { store, projectRoot: repoRoot, now: NOW });
    const topology = store.read();
    return {
      services: topology.services,
      nodes: topology.nodes,
      bindings: topology.bindings,
      state: services.topologyServiceToServiceState(topology.services[0], topology),
    };
  },
);

await addCase(
  "drops live bindings when a service stops",
  "upsert-running-then-stopped",
  () => ({ service: { id: "service-api", command: "zsh", args: ["-lc", "yarn api"], launchCommandLine: "yarn api" }, tmuxTarget: target("@3", 3, "api") }),
  ({ store, repoRoot }, input) => {
    services.upsertTopologyService({ ...input.service, tmuxTarget: input.tmuxTarget }, "running", { store, projectRoot: repoRoot, now: NOW });
    services.upsertTopologyService(input.service, "stopped", { store, projectRoot: repoRoot, now: LATER });
    return { bindings: store.read().bindings, stopped: services.listTopologyServiceStates({ statuses: ["stopped"], store }) };
  },
);

await addCase(
  "drops tmux bindings for stopped services",
  "upsert-stopped-with-target",
  () => ({ service: { id: "service-api", command: "zsh", args: ["-lc", "yarn api"], launchCommandLine: "yarn api", tmuxTarget: target("@3", 3, "api") } }),
  ({ store, repoRoot }, input) => {
    services.upsertTopologyService(input.service, "stopped", { store, projectRoot: repoRoot, now: NOW });
    return { bindings: store.read().bindings, stopped: services.listTopologyServiceStates({ statuses: ["stopped"], store }) };
  },
);

await addCase(
  "batch upserts multiple service records in one topology update",
  "batch-upsert-stopped",
  () => ({
    services: [
      { id: "service-api", launchCommandLine: "yarn api", tmuxTarget: target("@3", 3, "api") },
      { id: "service-web", launchCommandLine: "yarn web", tmuxTarget: target("@4", 4, "web") },
    ],
  }),
  ({ store, repoRoot }, input) => {
    services.upsertTopologyServices(input.services, "stopped", { store, projectRoot: repoRoot, now: NOW });
    return { stopped: services.listTopologyServiceStates({ statuses: ["stopped"], store }), bindings: store.read().bindings };
  },
);

await addCase(
  "removes service topology and dependent operation references",
  "remove-service",
  () => ({ service: { id: "service-web", command: "zsh" } }),
  ({ store, repoRoot }, input) => {
    services.upsertTopologyService(input.service, "stopped", { store, projectRoot: repoRoot, now: NOW });
    store.update((topology) => {
      topology.lifecycleOperations.push({
        id: "op-remove-service",
        rigId: topology.rigs[0].id,
        kind: "service.remove",
        status: "pending",
        targetKind: "service",
        targetId: "service-web",
        startedAt: NOW,
        updatedAt: NOW,
      });
      return topology;
    });
    const removed = services.removeTopologyService("service-web", { store, now: LATER });
    const topology = store.read();
    return { removed, services: topology.services, nodes: topology.nodes, lifecycleOperations: topology.lifecycleOperations };
  },
);

await addCase(
  "removes services for a worktree and keeps other services",
  "remove-services-for-worktree",
  (repoRoot) => ({ worktreePath: join(repoRoot, "feature-a"), keepPath: repoRoot }),
  ({ store, repoRoot }, input) => {
    services.upsertTopologyService({ id: "service-a", command: "zsh", worktreePath: input.worktreePath }, "stopped", { store, projectRoot: repoRoot, now: NOW });
    services.upsertTopologyService({ id: "service-b", command: "zsh", worktreePath: input.keepPath }, "stopped", { store, projectRoot: repoRoot, now: LATER });
    const removed = services.removeTopologyServicesForWorktree(input.worktreePath, { store, now: LATER });
    const topology = store.read();
    return { removed, serviceIds: topology.services.map((service) => service.id), nodeIds: topology.nodes.map((node) => node.id) };
  },
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/runtime-core/topology-services.test.ts",
  generatedBy: "scripts/capture-runtime-topology-services-contract.mjs",
  description: "Runtime topology service lifecycle and removal contracts captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
