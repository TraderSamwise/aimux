import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

    writeFileSync(
      join(tmpHome, ".aimux", "projects", "proj-a", "instances.json"),
      JSON.stringify([
        {
          instanceId: "server-a",
          pid: process.pid,
          sessions: [{ id: "session-a", tool: "codex" }],
        },
      ]),
    );
    writeFileSync(
      join(tmpHome, ".aimux", "projects", "proj-b", "instances.json"),
      JSON.stringify([
        {
          instanceId: "server-b",
          pid: process.pid,
          sessions: [{ id: "session-b", tool: "claude" }],
        },
      ]),
    );
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

  it("enriches live sessions from fresh statusline data", async () => {
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
        status: "waiting",
        role: "coder",
      }),
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
          sessions: expect.arrayContaining([
            expect.objectContaining({
              id: "session-a",
              tool: "codex",
            }),
          ]),
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
