import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      });

      expect(store.read()).toMatchObject({
        version: 1,
        rigs: [{ id: "rig-main" }],
        nodes: [{ id: "node-codex-1", logicalId: "codex-1" }],
        bindings: [{ nodeId: "node-codex-1", tmuxWindowId: "@1" }],
        sessions: [{ id: "codex-1", backendSessionId: "backend-1" }],
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
});
