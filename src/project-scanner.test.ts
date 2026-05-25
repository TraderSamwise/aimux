import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeTopologyStore, emptyRuntimeTopology } from "./runtime-core/topology-store.js";

let tmpHome: string;
let projectA: string;
let projectB: string;
let registryProjects: Array<{ id: string; name: string; repoRoot: string; lastSeen: string }>;

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => tmpHome,
  };
});

vi.mock("./paths.js", () => ({
  getAimuxDirFor: (cwd: string) => join(cwd, ".aimux"),
  getProjectStateDirById: (id: string) => join(tmpHome, ".aimux", "projects", id),
  listProjects: () => registryProjects,
}));

function makeTmpDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function writeTopologySession(
  projectId: string,
  projectPath: string,
  session: { id: string; tool: string; status?: "running" | "idle" | "waiting" | "offline" },
) {
  const projectStateDir = join(tmpHome, ".aimux", "projects", projectId);
  const now = "2026-05-25T00:00:00.000Z";
  new RuntimeTopologyStore(join(projectStateDir, "runtime-topology.yaml")).write({
    ...emptyRuntimeTopology(now),
    rigs: [{ id: `rig-${projectId}`, name: projectId, projectRoot: projectPath, createdAt: now, updatedAt: now }],
    nodes: [
      {
        id: `node-${session.id}`,
        rigId: `rig-${projectId}`,
        logicalId: session.id,
        toolConfigKey: session.tool,
        cwd: projectPath,
        createdAt: now,
      },
    ],
    sessions: [
      {
        id: session.id,
        nodeId: `node-${session.id}`,
        status: session.status ?? "running",
        tool: session.tool,
        command: session.tool,
        args: [],
        worktreePath: projectPath,
        createdAt: now,
        updatedAt: now,
      },
    ],
  });
}

describe("project-scanner", () => {
  beforeEach(() => {
    tmpHome = makeTmpDir("aimux-home-");
    projectA = join(tmpHome, "work", "project-a");
    projectB = join(tmpHome, "work", "project-b");
    registryProjects = [
      { id: "proj-a", name: "project-a", repoRoot: projectA, lastSeen: "2026-03-28T00:00:00.000Z" },
      { id: "proj-b", name: "project-b", repoRoot: projectB, lastSeen: "2026-03-28T00:00:00.000Z" },
    ];

    mkdirSync(join(projectA, ".aimux"), { recursive: true });
    mkdirSync(join(projectB, ".aimux"), { recursive: true });
    mkdirSync(join(tmpHome, ".aimux", "projects", "proj-a", "status"), { recursive: true });
    mkdirSync(join(tmpHome, ".aimux", "projects", "proj-b", "status"), { recursive: true });

    writeTopologySession("proj-a", projectA, { id: "session-a", tool: "codex" });
    writeTopologySession("proj-b", projectB, { id: "session-b", tool: "claude" });
    writeFileSync(join(tmpHome, ".aimux", "projects", "proj-a", "status", "session-a.md"), "Alpha headline\n");
    writeFileSync(join(tmpHome, ".aimux", "projects", "proj-b", "status", "session-b.md"), "Beta headline\n");
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("reads status headlines from the scanned project's own status directory", async () => {
    const { scanProject } = await import("./project-scanner.js");

    const resultA = scanProject(projectA);
    const resultB = scanProject(projectB);

    expect(resultA.sessions).toHaveLength(1);
    expect(resultA.sessions[0]).toEqual(
      expect.objectContaining({
        id: "session-a",
        headline: "Alpha headline",
      }),
    );

    expect(resultB.sessions).toHaveLength(1);
    expect(resultB.sessions[0]).toEqual(
      expect.objectContaining({
        id: "session-b",
        headline: "Beta headline",
      }),
    );
  });

  it("enriches topology sessions from fresh statusline data without overriding topology status", async () => {
    writeFileSync(
      join(tmpHome, ".aimux", "projects", "proj-a", "statusline.json"),
      JSON.stringify({
        sessions: [
          {
            id: "session-a",
            tool: "codex",
            label: "chart-fix",
            headline: "auditing session routing",
            status: "waiting",
            role: "coder",
          },
        ],
      }),
    );

    const { scanProject } = await import("./project-scanner.js");
    const result = scanProject(projectA);

    expect(result.sessions[0]).toEqual(
      expect.objectContaining({
        id: "session-a",
        label: "chart-fix",
        headline: "auditing session routing",
        status: "running",
        role: "coder",
      }),
    );
  });

  it("does not mint project sessions from statusline-only data", async () => {
    writeFileSync(
      join(tmpHome, ".aimux", "projects", "proj-a", "statusline.json"),
      JSON.stringify({
        sessions: [
          {
            id: "statusline-only",
            tool: "codex",
            headline: "stale statusline row",
            status: "waiting",
          },
        ],
      }),
    );

    const { scanProject } = await import("./project-scanner.js");
    const result = scanProject(projectA);

    expect(result.sessions.map((session) => session.id)).toEqual(["session-a"]);
  });

  it("does not mint project sessions from instances-only data", async () => {
    const projectC = join(tmpHome, "work", "project-c");
    mkdirSync(join(projectC, ".aimux"), { recursive: true });
    registryProjects = [
      ...registryProjects,
      { id: "proj-c", name: "project-c", repoRoot: projectC, lastSeen: "2026-03-28T00:00:00.000Z" },
    ];
    mkdirSync(join(tmpHome, ".aimux", "projects", "proj-c"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".aimux", "projects", "proj-c", "instances.json"),
      JSON.stringify([
        {
          instanceId: "server-c",
          pid: process.pid,
          sessions: [{ id: "session-c", tool: "codex" }],
        },
      ]),
    );

    const { scanProject } = await import("./project-scanner.js");

    expect(scanProject(projectC).sessions).toEqual([]);
  });

  it("loads project sessions from runtime topology with topology status", async () => {
    const projectStateDir = join(tmpHome, ".aimux", "projects", "proj-a");
    const now = "2026-05-25T00:00:00.000Z";
    new RuntimeTopologyStore(join(projectStateDir, "runtime-topology.yaml")).write({
      ...emptyRuntimeTopology(now),
      rigs: [{ id: "rig-a", name: "project-a", projectRoot: projectA, createdAt: now, updatedAt: now }],
      nodes: [
        {
          id: "node-topology-idle",
          rigId: "rig-a",
          logicalId: "topology-idle",
          toolConfigKey: "codex",
          cwd: projectA,
          label: "topology",
          createdAt: now,
        },
      ],
      sessions: [
        {
          id: "topology-idle",
          nodeId: "node-topology-idle",
          status: "idle",
          tool: "codex",
          command: "codex",
          args: [],
          worktreePath: projectA,
          label: "topology",
          headline: "from topology",
          createdAt: now,
          updatedAt: now,
        },
      ],
    });

    const { scanProject } = await import("./project-scanner.js");
    const result = scanProject(projectA);

    expect(result.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "topology-idle",
          status: "idle",
          label: "topology",
          headline: "from topology",
        }),
      ]),
    );
  });

  it("builds desktop project summaries with dashboard session names", async () => {
    const { listDesktopProjects } = await import("./project-scanner.js");
    const projects = listDesktopProjects();

    expect(projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "proj-a",
          name: "project-a",
          path: projectA,
          dashboardSessionName: expect.stringMatching(/^aimux-project-a-/),
        }),
        expect.objectContaining({
          id: "proj-b",
          name: "project-b",
          path: projectB,
          dashboardSessionName: expect.stringMatching(/^aimux-project-b-/),
        }),
      ]),
    );
  });

  it("hides missing and tmp aimux registry entries from the desktop list", async () => {
    const tempTestProject = makeTmpDir("aimux-agent-tracker-");
    mkdirSync(join(tempTestProject, ".aimux"), { recursive: true });
    writeFileSync(
      join(tempTestProject, ".aimux", "instances.json"),
      JSON.stringify([
        {
          instanceId: "server-temp",
          pid: process.pid,
          sessions: [{ id: "session-temp", tool: "claude" }],
        },
      ]),
    );

    registryProjects = [
      ...registryProjects,
      { id: "temp-proj", name: "temp-proj", repoRoot: tempTestProject, lastSeen: "2026-03-28T00:00:00.000Z" },
      {
        id: "missing-proj",
        name: "missing-proj",
        repoRoot: join(tmpHome, "missing-project"),
        lastSeen: "2026-03-28T00:00:00.000Z",
      },
    ];

    const { listDesktopProjects } = await import("./project-scanner.js");
    const projects = listDesktopProjects();

    expect(projects.map((project) => project.path)).toEqual(expect.arrayContaining([projectA, projectB]));
    expect(projects.map((project) => project.path)).not.toContain(tempTestProject);
    expect(projects.map((project) => project.id)).not.toContain("missing-proj");

    rmSync(tempTestProject, { recursive: true, force: true });
  });
});
