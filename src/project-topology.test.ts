import { describe, expect, it } from "vitest";
import { buildProjectTopology, healthForStatus, rollupHealth } from "./project-topology.js";

describe("healthForStatus", () => {
  it("maps status + pendingAction to health", () => {
    expect(healthForStatus("running")).toBe("active");
    expect(healthForStatus("waiting")).toBe("attention");
    expect(healthForStatus("idle")).toBe("idle");
    expect(healthForStatus("offline")).toBe("offline");
    expect(healthForStatus("exited")).toBe("offline");
    expect(healthForStatus("running", "stopping")).toBe("attention"); // pending wins
    expect(healthForStatus(undefined)).toBe("idle");
  });
});

describe("rollupHealth", () => {
  it("returns the highest-priority health, idle when empty", () => {
    expect(rollupHealth([])).toBe("idle");
    expect(rollupHealth(["offline", "idle"])).toBe("idle");
    expect(rollupHealth(["idle", "active"])).toBe("active");
    expect(rollupHealth(["active", "attention"])).toBe("attention");
    expect(rollupHealth(["offline", "offline"])).toBe("offline");
  });
});

describe("buildProjectTopology", () => {
  it("builds worktree views, flattened rows, counts and rolled-up health", () => {
    const topo = buildProjectTopology({
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
    });

    expect(topo.counts).toEqual({ worktrees: 2, agents: 3, services: 1 });
    // main has a waiting agent -> attention; project rolls up to attention
    expect(topo.worktrees[0]!.health).toBe("attention");
    expect(topo.worktrees[1]!.health).toBe("offline");
    expect(topo.health).toBe("attention");

    // rows: worktree, its 2 agents + 1 service, then worktree + 1 agent
    expect(topo.rows.map((r) => r.kind)).toEqual(["worktree", "agent", "agent", "service", "worktree", "agent"]);
    const agentRow = topo.rows.find((r) => r.sessionId === "a1")!;
    expect(agentRow).toMatchObject({ kind: "agent", depth: 1, label: "coder", detail: "coder", health: "active" });
    const serviceRow = topo.rows.find((r) => r.serviceId === "s1")!;
    expect(serviceRow).toMatchObject({ kind: "service", health: "active", worktreePath: "/repo" });
  });

  it("treats a pending/removing worktree health specially", () => {
    const topo = buildProjectTopology({
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
    });
    expect(topo.worktrees[0]!.health).toBe("attention"); // pending
    expect(topo.worktrees[1]!.health).toBe("offline"); // removing overrides running child
  });

  it("handles an empty project", () => {
    const topo = buildProjectTopology({ projectName: "empty", worktrees: [] });
    expect(topo.health).toBe("idle");
    expect(topo.rows).toEqual([]);
    expect(topo.counts).toEqual({ worktrees: 0, agents: 0, services: 0 });
  });
});
