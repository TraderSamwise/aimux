import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initPaths } from "../paths.js";
import { createRuntimeTopologyStore, emptyRuntimeTopology } from "./topology-store.js";
import {
  moveTopologySessionToGraveyard,
  resurrectTopologySession,
  saveRuntimeTopologySessions,
  topologySessionToSessionState,
  upsertTopologySession,
} from "./topology-sessions.js";

describe("topology session lifecycle", () => {
  let repoRoot = "";
  let topologyPath = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-topology-sessions-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
    topologyPath = join(repoRoot, ".aimux", "runtime-topology.yaml");
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("drops tmux bindings when sessions move to graveyard or offline", () => {
    const store = createRuntimeTopologyStore(topologyPath);
    upsertTopologySession(
      {
        id: "codex-1",
        tool: "codex",
        toolConfigKey: "codex",
        command: "codex",
        args: [],
        tmuxTarget: { sessionName: "aimux-repo", windowId: "@1", windowIndex: 1, windowName: "codex" },
      },
      "running",
      { store, projectRoot: repoRoot },
    );

    expect(store.read().bindings).toHaveLength(1);
    const moved = moveTopologySessionToGraveyard("codex-1", undefined, { store });
    expect(moved?.tmuxTarget).toEqual({
      sessionName: "aimux-repo",
      windowId: "@1",
      windowIndex: 1,
      windowName: "codex",
    });
    expect(store.read().bindings).toEqual([]);

    const restored = resurrectTopologySession("codex-1", { store });
    expect(restored?.tmuxTarget).toBeUndefined();
    expect(store.read().bindings).toEqual([]);
  });

  it("prunes graph and queue references when saving replacement session topology", () => {
    const store = createRuntimeTopologyStore(topologyPath);
    const now = "2026-05-25T00:00:00.000Z";
    store.write({
      ...emptyRuntimeTopology(now),
      rigs: [{ id: "rig-a", name: "repo", projectRoot: repoRoot, createdAt: now, updatedAt: now }],
      nodes: [
        { id: "agent:keep", rigId: "rig-a", logicalId: "keep", createdAt: now },
        { id: "agent:drop", rigId: "rig-a", logicalId: "drop", createdAt: now },
      ],
      edges: [
        {
          id: "edge-drop",
          rigId: "rig-a",
          sourceNodeId: "agent:keep",
          targetNodeId: "agent:drop",
          kind: "team",
          createdAt: now,
        },
      ],
      bindings: [
        {
          id: "tmux:drop",
          nodeId: "agent:drop",
          tmuxSession: "aimux-repo",
          tmuxWindowId: "@9",
          tmuxWindowIndex: 9,
          updatedAt: now,
        },
      ],
      sessions: [
        {
          id: "drop",
          nodeId: "agent:drop",
          status: "running",
          tool: "codex",
          command: "codex",
          createdAt: now,
          updatedAt: now,
        },
      ],
      queue: [
        {
          id: "queue-drop",
          targetSessionId: "drop",
          status: "queued",
          kind: "task",
          createdAt: now,
          updatedAt: now,
        },
      ],
    });

    const topology = saveRuntimeTopologySessions({
      store,
      projectRoot: repoRoot,
      now,
      sessions: [
        {
          id: "keep",
          tool: "codex",
          toolConfigKey: "codex",
          command: "codex",
          args: [],
          lifecycle: "offline",
        },
      ],
    });

    expect(topology.sessions.map((session) => session.id)).toEqual(["keep"]);
    expect(topology.bindings).toEqual([]);
    expect(topology.edges).toEqual([]);
    expect(topology.queue).toEqual([]);
    expect(topologySessionToSessionState(topology.sessions[0], topology).tmuxTarget).toBeUndefined();
  });
});
