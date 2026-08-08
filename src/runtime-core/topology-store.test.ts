import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeTopologyStore, emptyRuntimeTopology } from "./topology-store.js";

describe("RuntimeTopologyStore", () => {
  // `team` is the only session field typed `unknown`, so it is the only one the coercer
  // cannot rebuild structurally. It is cloned instead, on both the read and the write
  // path (write coerces too), so no reference is shared with the caller in either
  // direction. Everything else is rebuilt field by field.
  it("does not share the team object with its caller in either direction", () => {
    const dir = mkdtempSync(join(tmpdir(), "aimux-runtime-topology-"));
    try {
      const store = new RuntimeTopologyStore(join(dir, "runtime-topology.yaml"));
      const now = "2026-05-25T00:00:00.000Z";
      const team = { name: "reviewers", role: "reviewer", members: ["codex-1"] };
      const written = store.write({
        ...emptyRuntimeTopology(now),
        rigs: [{ id: "rig-main", name: "aimux", projectRoot: "/repo", createdAt: now, updatedAt: now }],
        nodes: [
          {
            id: "node-codex-1",
            rigId: "rig-main",
            logicalId: "codex-1",
            runtime: "codex",
            toolConfigKey: "codex",
            cwd: "/repo",
            createdAt: now,
          },
        ],
        sessions: [
          {
            id: "codex-1",
            nodeId: "node-codex-1",
            status: "running",
            tool: "codex",
            command: "codex",
            args: [],
            team,
            createdAt: now,
            updatedAt: now,
          },
        ],
      });

      expect(written.sessions[0].team).toEqual(team);
      expect(written.sessions[0].team).not.toBe(team);

      const first = store.read();
      expect(first.sessions[0].team).toEqual(team);

      (first.sessions[0].team as { name: string }).name = "clobbered";
      (first.sessions[0].team as { members: string[] }).members.push("injected");

      expect(store.read().sessions[0].team).toEqual(team);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The read cache stores the raw parse and re-coerces per read, which is only safe
  // while coerceRuntimeTopology rebuilds every nested value. `update()` mutates the read
  // result in place, so a passthrough would corrupt the cache for the whole process.
  it("never lets a caller's mutation leak into a later read", () => {
    const dir = mkdtempSync(join(tmpdir(), "aimux-runtime-topology-"));
    try {
      const store = new RuntimeTopologyStore(join(dir, "runtime-topology.yaml"));
      const now = "2026-05-25T00:00:00.000Z";
      store.write({
        ...emptyRuntimeTopology(now),
        rigs: [{ id: "rig-main", name: "aimux", projectRoot: "/repo", createdAt: now, updatedAt: now }],
        nodes: [
          {
            id: "node-codex-1",
            rigId: "rig-main",
            logicalId: "codex-1",
            runtime: "codex",
            toolConfigKey: "codex",
            cwd: "/repo",
            createdAt: now,
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
            team: { name: "reviewers", members: ["codex-1"] },
            createdAt: now,
            updatedAt: now,
          },
        ],
        services: [
          {
            id: "service-web",
            rigId: "rig-main",
            nodeId: "node-codex-1",
            status: "running",
            launchCommandLine: "yarn web",
            args: ["web"],
            createdAt: now,
            updatedAt: now,
          },
        ],
        worktrees: [
          {
            id: "worktree-main",
            rigId: "rig-main",
            name: "main",
            path: "/repo",
            status: "active",
            createdAt: now,
            updatedAt: now,
          },
        ],
        // Every record type is seeded so a passthrough added to any of them trips this,
        // not just the ones the dashboard path happens to read. One exception worth
        // knowing: remoteClients.ownsSessionIds is additionally rebuilt by
        // normalizeRuntimeTopology's filter, so it stays safe by that route and a
        // passthrough there would not be caught here.
        edges: [
          {
            id: "edge-1",
            rigId: "rig-main",
            sourceNodeId: "node-codex-1",
            targetNodeId: "node-codex-1",
            kind: "peer",
            createdAt: now,
          },
        ],
        bindings: [{ id: "binding-1", nodeId: "node-codex-1", tmuxSession: "aimux-repo", updatedAt: now }],
        worktreeGraveyard: [
          { id: "grave-1", rigId: "rig-main", path: "/repo/old", graveyardedAt: now, reason: "stale" },
        ],
        teamRoles: [{ id: "role-1", rigId: "rig-main", role: "reviewer", createdAt: now, updatedAt: now }],
        remoteClients: [
          {
            id: "client-1",
            rigId: "rig-main",
            status: "connected",
            lastSeenAt: now,
            ownsSessionIds: ["codex-1"],
          },
        ],
        lifecycleOperations: [
          {
            id: "op-1",
            rigId: "rig-main",
            kind: "spawn",
            status: "running",
            targetKind: "session",
            targetId: "codex-1",
            startedAt: now,
            updatedAt: now,
          },
        ],
        exchangeRefs: [
          {
            id: "ref-1",
            rigId: "rig-main",
            kind: "task",
            exchangeId: "task-1",
            createdAt: now,
            updatedAt: now,
          },
        ],
      });

      // Deep-copied on purpose: if a passthrough aliased the cache, this handle would be
      // poisoned by the mutations below too and the comparison would pass while both
      // sides were corrupt.
      const pristine = structuredClone(store.read());
      const mutated = store.read();
      mutated.sessions[0].args.push("injected");
      mutated.sessions[0].command = "clobbered";
      (mutated.sessions[0].team as { name: string }).name = "clobbered";
      (mutated.sessions[0].team as { members: string[] }).members.push("injected");
      // Non-optional on purpose: `?.` would silently no-op and make this vacuous if the
      // fixture ever stopped seeding args.
      (mutated.services[0].args as string[]).push("injected");
      mutated.worktrees[0].path = "/clobbered";
      mutated.nodes[0].cwd = "/clobbered";
      mutated.rigs[0].name = "clobbered";
      mutated.edges[0].kind = "clobbered";
      mutated.bindings[0].tmuxSession = "clobbered";
      mutated.worktreeGraveyard[0].path = "/clobbered";
      mutated.teamRoles[0].role = "clobbered";
      (mutated.remoteClients[0].ownsSessionIds as string[]).push("injected");
      mutated.lifecycleOperations[0].targetId = "clobbered";
      mutated.exchangeRefs[0].exchangeId = "clobbered";
      mutated.sessions.push({ ...mutated.sessions[0], id: "injected" });

      expect(store.read()).toEqual(pristine);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serves a rewritten file rather than a cached parse", () => {
    const dir = mkdtempSync(join(tmpdir(), "aimux-runtime-topology-"));
    try {
      const path = join(dir, "runtime-topology.yaml");
      const store = new RuntimeTopologyStore(path);
      const now = "2026-05-25T00:00:00.000Z";
      store.write({
        ...emptyRuntimeTopology(now),
        rigs: [{ id: "rig-main", name: "aimux", projectRoot: "/repo", createdAt: now, updatedAt: now }],
      });
      expect(store.read().rigs[0].name).toBe("aimux");

      // Written outside the store, mimicking another process, and byte-length identical
      // so a size-based cache key would not notice the change.
      const before = readFileSync(path, "utf-8");
      const after = before.replace("name: aimux", "name: aimuz");
      expect(after).not.toBe(before);
      expect(after.length).toBe(before.length);
      writeFileSync(path, after);
      expect(store.read().rigs[0].name).toBe("aimuz");

      rmSync(path, { force: true });
      expect(store.read().rigs).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
      // PID is above every platform's pid_max so it is reliably dead.
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "owner"), "2147483647\n");
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
