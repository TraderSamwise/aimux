import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeTopologyStore, emptyRuntimeTopology } from "./topology-store.js";

describe("RuntimeTopologyStore", () => {
  it("round-trips the OpenRig-style runtime topology YAML", () => {
    const dir = mkdtempSync(join(tmpdir(), "aimux-runtime-topology-"));
    try {
      const store = new RuntimeTopologyStore(join(dir, "runtime-topology.yaml"));
      const now = "2026-05-25T00:00:00.000Z";
      store.write({
        ...emptyRuntimeTopology(now),
        rigs: [
          {
            id: "rig-main",
            name: "aimux",
            projectRoot: "/repo",
            createdAt: now,
            updatedAt: now,
          },
        ],
        nodes: [
          {
            id: "node-codex-1",
            rigId: "rig-main",
            logicalId: "codex-1",
            runtime: "codex",
            toolConfigKey: "codex",
            cwd: "/repo",
            label: "coder",
            createdAt: now,
          },
        ],
        bindings: [
          {
            id: "binding-codex-1",
            nodeId: "node-codex-1",
            tmuxSession: "aimux-repo",
            tmuxWindowId: "@1",
            tmuxWindowIndex: 1,
            tmuxWindowName: "codex",
            updatedAt: now,
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
            createdAt: now,
            updatedAt: now,
            lastSeenAt: now,
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
            createdAt: now,
            updatedAt: now,
            lastSeenAt: now,
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
            createdAt: now,
            updatedAt: now,
          },
        ],
        worktreeGraveyard: [
          {
            id: "graveyard-old",
            rigId: "rig-main",
            worktreeId: "worktree-main",
            path: "/repo-old",
            name: "old",
            graveyardedAt: now,
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
            createdAt: now,
            updatedAt: now,
          },
        ],
        remoteClients: [
          {
            id: "client-sam",
            rigId: "rig-main",
            userId: "sam",
            status: "online",
            connectedAt: now,
            lastSeenAt: now,
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
            startedAt: now,
            updatedAt: now,
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
            createdAt: now,
            updatedAt: now,
          },
        ],
      });

      expect(store.read()).toMatchObject({
        version: 1,
        rigs: [{ id: "rig-main" }],
        nodes: [{ id: "node-codex-1", logicalId: "codex-1" }],
        bindings: [{ nodeId: "node-codex-1", tmuxWindowId: "@1" }],
        sessions: [{ id: "codex-1", backendSessionId: "backend-1" }],
        services: [{ id: "service-web", status: "running", launchCommandLine: "yarn web" }],
        worktrees: [{ id: "worktree-main", path: "/repo", status: "active" }],
        worktreeGraveyard: [{ id: "graveyard-old", worktreeId: "worktree-main" }],
        teamRoles: [{ id: "role-coder", nodeId: "node-codex-1", role: "coder" }],
        remoteClients: [{ id: "client-sam", ownsSessionIds: ["codex-1"] }],
        lifecycleOperations: [{ id: "op-stop-codex", targetKind: "session", targetId: "codex-1" }],
        exchangeRefs: [{ id: "exchange-task-1", kind: "task", exchangeId: "task-1" }],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects corrupt topology YAML instead of silently resetting runtime truth", () => {
    const dir = mkdtempSync(join(tmpdir(), "aimux-runtime-topology-"));
    try {
      const path = join(dir, "runtime-topology.yaml");
      writeFileSync(path, "version: nope\n");
      expect(() => new RuntimeTopologyStore(path).read()).toThrow("unsupported runtime topology version");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported lifecycle target kinds instead of remapping them", () => {
    const dir = mkdtempSync(join(tmpdir(), "aimux-runtime-topology-"));
    try {
      const path = join(dir, "runtime-topology.yaml");
      const now = "2026-05-25T00:00:00.000Z";
      writeFileSync(
        path,
        [
          "version: 1",
          `generatedAt: ${now}`,
          "rigs:",
          "  - id: rig-main",
          "    name: repo",
          "    projectRoot: /repo",
          `    createdAt: ${now}`,
          `    updatedAt: ${now}`,
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
          `    startedAt: ${now}`,
          `    updatedAt: ${now}`,
          "exchangeRefs: []",
          "",
        ].join("\n"),
      );

      expect(() => new RuntimeTopologyStore(path).read()).toThrow(
        "lifecycleOperations[0].targetKind must be a supported target kind",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported exchange reference kinds instead of remapping them", () => {
    const dir = mkdtempSync(join(tmpdir(), "aimux-runtime-topology-"));
    try {
      const path = join(dir, "runtime-topology.yaml");
      const now = "2026-05-25T00:00:00.000Z";
      writeFileSync(
        path,
        [
          "version: 1",
          `generatedAt: ${now}`,
          "rigs:",
          "  - id: rig-main",
          "    name: repo",
          "    projectRoot: /repo",
          `    createdAt: ${now}`,
          `    updatedAt: ${now}`,
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
          `    createdAt: ${now}`,
          `    updatedAt: ${now}`,
          "",
        ].join("\n"),
      );

      expect(() => new RuntimeTopologyStore(path).read()).toThrow(
        "exchangeRefs[0].kind must be a supported exchange ref kind",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serializes update with a filesystem lock and releases it after writing", () => {
    const dir = mkdtempSync(join(tmpdir(), "aimux-runtime-topology-"));
    try {
      const path = join(dir, "runtime-topology.yaml");
      const store = new RuntimeTopologyStore(path);

      store.update((topology) => ({
        ...topology,
        rigs: [
          {
            id: "rig-main",
            name: "repo",
            projectRoot: "/repo",
            createdAt: topology.generatedAt,
            updatedAt: topology.generatedAt,
          },
        ],
        nodes: [
          {
            id: "agent:codex-1",
            rigId: "rig-main",
            logicalId: "codex-1",
            createdAt: topology.generatedAt,
          },
        ],
        sessions: [
          {
            id: "codex-1",
            nodeId: "agent:codex-1",
            status: "offline",
            createdAt: topology.generatedAt,
            updatedAt: topology.generatedAt,
          },
        ],
      }));

      expect(existsSync(`${path}.lock`)).toBe(false);
      expect(store.read().sessions.map((session) => session.id)).toEqual(["codex-1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reclaims a stale lock left behind by a dead owner instead of timing out", () => {
    const dir = mkdtempSync(join(tmpdir(), "aimux-runtime-topology-"));
    try {
      const path = join(dir, "runtime-topology.yaml");
      const lockPath = `${path}.lock`;
      // Simulate a crashed process: a lock dir whose owner PID is not running,
      // aged past the grace period. This used to wedge every update forever.
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "owner"), "999999\n");
      const past = new Date(Date.now() - 10_000);
      utimesSync(lockPath, past, past);

      const store = new RuntimeTopologyStore(path);
      const updated = store.update((topology) => topology);

      expect(updated.version).toBe(1);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prunes extended topology references to missing rigs, nodes, sessions, services, and worktrees", () => {
    const dir = mkdtempSync(join(tmpdir(), "aimux-runtime-topology-"));
    try {
      const path = join(dir, "runtime-topology.yaml");
      const store = new RuntimeTopologyStore(path);
      const now = "2026-05-25T00:00:00.000Z";

      store.write({
        ...emptyRuntimeTopology(now),
        rigs: [{ id: "rig-main", name: "repo", projectRoot: "/repo", createdAt: now, updatedAt: now }],
        nodes: [{ id: "agent:keep", rigId: "rig-main", logicalId: "keep", createdAt: now }],
        sessions: [{ id: "keep", nodeId: "agent:keep", status: "offline", createdAt: now, updatedAt: now }],
        services: [
          {
            id: "service-keep",
            rigId: "rig-main",
            status: "running",
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "service-drop",
            rigId: "missing-rig",
            status: "running",
            createdAt: now,
            updatedAt: now,
          },
        ],
        worktrees: [
          {
            id: "worktree-keep",
            rigId: "rig-main",
            path: "/repo",
            name: "repo",
            status: "active",
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "worktree-drop",
            rigId: "missing-rig",
            path: "/repo/drop",
            name: "drop",
            status: "active",
            createdAt: now,
            updatedAt: now,
          },
        ],
        worktreeGraveyard: [
          {
            id: "graveyard-keep",
            rigId: "rig-main",
            worktreeId: "worktree-keep",
            path: "/repo-old",
            graveyardedAt: now,
          },
          {
            id: "graveyard-drop",
            rigId: "rig-main",
            worktreeId: "worktree-drop",
            path: "/repo-drop",
            graveyardedAt: now,
          },
        ],
        teamRoles: [
          { id: "role-keep", rigId: "rig-main", nodeId: "agent:keep", role: "coder", createdAt: now, updatedAt: now },
          { id: "role-drop", rigId: "rig-main", nodeId: "agent:drop", role: "coder", createdAt: now, updatedAt: now },
        ],
        remoteClients: [
          {
            id: "client-keep",
            rigId: "rig-main",
            status: "online",
            lastSeenAt: now,
            ownsSessionIds: ["keep", "drop"],
          },
        ],
        lifecycleOperations: [
          {
            id: "op-keep",
            rigId: "rig-main",
            kind: "agent.stop",
            status: "pending",
            targetKind: "session",
            targetId: "keep",
            startedAt: now,
            updatedAt: now,
          },
          {
            id: "op-drop",
            rigId: "rig-main",
            kind: "service.stop",
            status: "pending",
            targetKind: "service",
            targetId: "service-drop",
            startedAt: now,
            updatedAt: now,
          },
        ],
        exchangeRefs: [
          {
            id: "exchange-keep",
            rigId: "rig-main",
            kind: "task",
            exchangeId: "task-1",
            sessionId: "keep",
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "exchange-drop",
            rigId: "rig-main",
            kind: "task",
            exchangeId: "task-2",
            sessionId: "drop",
            createdAt: now,
            updatedAt: now,
          },
        ],
      });

      const topology = store.read();
      expect(topology.services.map((service) => service.id)).toEqual(["service-keep"]);
      expect(topology.worktrees.map((worktree) => worktree.id)).toEqual(["worktree-keep"]);
      expect(topology.worktreeGraveyard.map((entry) => entry.id)).toEqual(["graveyard-keep", "graveyard-drop"]);
      expect(topology.teamRoles.map((role) => role.id)).toEqual(["role-keep"]);
      expect(topology.remoteClients).toMatchObject([{ id: "client-keep", ownsSessionIds: ["keep"] }]);
      expect(topology.lifecycleOperations.map((operation) => operation.id)).toEqual(["op-keep"]);
      expect(topology.exchangeRefs.map((ref) => ref.id)).toEqual(["exchange-keep"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
