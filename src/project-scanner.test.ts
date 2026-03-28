import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpHome: string;
let projectA: string;
let projectB: string;

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
  listProjects: () => [
    { id: "proj-a", name: "project-a", repoRoot: projectA, lastSeen: "2026-03-28T00:00:00.000Z" },
    { id: "proj-b", name: "project-b", repoRoot: projectB, lastSeen: "2026-03-28T00:00:00.000Z" },
  ],
}));

function makeTmpDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

describe("project-scanner", () => {
  beforeEach(() => {
    tmpHome = makeTmpDir("aimux-home-");
    projectA = join(tmpHome, "work", "project-a");
    projectB = join(tmpHome, "work", "project-b");

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
        isServer: true,
      }),
    );

    expect(resultB.sessions).toHaveLength(1);
    expect(resultB.sessions[0]).toEqual(
      expect.objectContaining({
        id: "session-b",
        headline: "Beta headline",
        isServer: true,
      }),
    );
  });
});
