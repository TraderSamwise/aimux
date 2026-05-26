import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initPaths } from "../paths.js";
import { createRuntimeTopologyStore } from "./topology-store.js";
import {
  listTopologyServiceStates,
  removeTopologyService,
  topologyServiceToServiceState,
  upsertTopologyService,
} from "./topology-services.js";

describe("topology service lifecycle", () => {
  let repoRoot = "";
  let topologyPath = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-topology-services-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
    topologyPath = join(repoRoot, ".aimux", "runtime-topology.yaml");
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("tracks live service state and tmux bindings in topology", () => {
    const store = createRuntimeTopologyStore(topologyPath);
    const now = "2026-05-25T00:00:00.000Z";
    upsertTopologyService(
      {
        id: "service-web",
        command: "zsh",
        args: ["-lc", "yarn web"],
        launchCommandLine: "yarn web",
        worktreePath: repoRoot,
        cwd: repoRoot,
        label: "web",
        tmuxTarget: { sessionName: "aimux-repo", windowId: "@2", windowIndex: 2, windowName: "web" },
      },
      "running",
      { store, projectRoot: repoRoot, now },
    );

    const topology = store.read();
    expect(topology.services).toMatchObject([
      {
        id: "service-web",
        status: "running",
        command: "zsh",
        launchCommandLine: "yarn web",
        worktreePath: repoRoot,
        lastSeenAt: now,
      },
    ]);
    expect(topology.nodes).toMatchObject([{ id: "service:service-web", logicalId: "service-web", role: "service" }]);
    expect(topology.bindings).toMatchObject([{ nodeId: "service:service-web", tmuxWindowId: "@2" }]);
    expect(topologyServiceToServiceState(topology.services[0], topology).tmuxTarget?.windowId).toBe("@2");
  });

  it("drops live bindings when a service stops", () => {
    const store = createRuntimeTopologyStore(topologyPath);
    const service = {
      id: "service-api",
      command: "zsh",
      args: ["-lc", "yarn api"],
      launchCommandLine: "yarn api",
    };
    upsertTopologyService(
      { ...service, tmuxTarget: { sessionName: "aimux-repo", windowId: "@3", windowIndex: 3, windowName: "api" } },
      "running",
      { store, projectRoot: repoRoot },
    );
    upsertTopologyService(service, "stopped", { store, projectRoot: repoRoot });

    expect(store.read().bindings).toEqual([]);
    expect(listTopologyServiceStates({ statuses: ["stopped"], store })).toMatchObject([
      { id: "service-api", status: "stopped", launchCommandLine: "yarn api" },
    ]);
  });

  it("marks stopped services with retained tmux bindings", () => {
    const store = createRuntimeTopologyStore(topologyPath);
    upsertTopologyService(
      {
        id: "service-api",
        command: "zsh",
        args: ["-lc", "yarn api"],
        launchCommandLine: "yarn api",
        tmuxTarget: { sessionName: "aimux-repo", windowId: "@3", windowIndex: 3, windowName: "api" },
      },
      "stopped",
      { store, projectRoot: repoRoot },
    );

    expect(listTopologyServiceStates({ statuses: ["stopped"], store })).toMatchObject([
      { id: "service-api", status: "stopped", launchCommandLine: "yarn api", retained: true },
    ]);
  });

  it("removes service topology and dependent operation references", () => {
    const store = createRuntimeTopologyStore(topologyPath);
    upsertTopologyService({ id: "service-web", command: "zsh" }, "stopped", { store, projectRoot: repoRoot });
    store.update((topology) => {
      topology.lifecycleOperations.push({
        id: "op-remove-service",
        rigId: topology.rigs[0].id,
        kind: "service.remove",
        status: "pending",
        targetKind: "service",
        targetId: "service-web",
        startedAt: "2026-05-25T00:00:00.000Z",
        updatedAt: "2026-05-25T00:00:00.000Z",
      });
      return topology;
    });

    const removed = removeTopologyService("service-web", { store });

    expect(removed?.id).toBe("service-web");
    expect(store.read().services).toEqual([]);
    expect(store.read().nodes).toEqual([]);
    expect(store.read().lifecycleOperations).toEqual([]);
  });
});
