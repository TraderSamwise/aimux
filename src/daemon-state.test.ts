import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDaemonStatePath } from "./paths.js";
import { loadDaemonState } from "./daemon-state.js";

let aimuxHome = "";
let gitProject = "";
let nonGitProject = "";

describe("daemon-state", () => {
  beforeEach(() => {
    aimuxHome = mkdtempSync(join(tmpdir(), "aimux-daemon-state-home-"));
    gitProject = mkdtempSync(join(tmpdir(), "aimux-daemon-state-git-"));
    nonGitProject = mkdtempSync(join(tmpdir(), "aimux-daemon-state-non-git-"));
    process.env.AIMUX_HOME = aimuxHome;
    mkdirSync(join(gitProject, ".git"), { recursive: true });
  });

  afterEach(() => {
    delete process.env.AIMUX_HOME;
    rmSync(aimuxHome, { recursive: true, force: true });
    rmSync(gitProject, { recursive: true, force: true });
    rmSync(nonGitProject, { recursive: true, force: true });
  });

  it("ignores non-git project service records", () => {
    mkdirSync(join(aimuxHome, "daemon"), { recursive: true });
    writeFileSync(
      getDaemonStatePath(),
      JSON.stringify({
        version: 1,
        updatedAt: "2026-08-25T00:00:00.000Z",
        projects: {
          git: {
            projectId: "git",
            projectRoot: gitProject,
            pid: 123,
            startedAt: "2026-08-25T00:00:00.000Z",
            updatedAt: "2026-08-25T00:00:00.000Z",
          },
          stale: {
            projectId: "stale",
            projectRoot: nonGitProject,
            pid: 456,
            startedAt: "2026-08-25T00:00:00.000Z",
            updatedAt: "2026-08-25T00:00:00.000Z",
          },
        },
      }),
    );

    expect(Object.keys(loadDaemonState().projects)).toEqual(["git"]);
  });

  it("ignores malformed project service records", () => {
    mkdirSync(join(aimuxHome, "daemon"), { recursive: true });
    writeFileSync(
      getDaemonStatePath(),
      JSON.stringify({
        version: 1,
        updatedAt: "2026-08-25T00:00:00.000Z",
        projects: {
          missingRoot: {
            projectId: "missingRoot",
            pid: 456,
            startedAt: "2026-08-25T00:00:00.000Z",
            updatedAt: "2026-08-25T00:00:00.000Z",
          },
          numericRoot: {
            projectId: "numericRoot",
            projectRoot: 123,
            pid: 789,
            startedAt: "2026-08-25T00:00:00.000Z",
            updatedAt: "2026-08-25T00:00:00.000Z",
          },
        },
      }),
    );

    expect(loadDaemonState().projects).toEqual({});
  });
});
