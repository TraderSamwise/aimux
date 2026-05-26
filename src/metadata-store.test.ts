import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { getReadOnlyProjectPathsFor, initPaths } from "./paths.js";
import { loadMetadataState, saveMetadataState } from "./metadata-store.js";

function gitInit(cwd: string): void {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_COMMON_DIR;
  execFileSync("git", ["init"], { cwd, stdio: "ignore", env });
}

describe("metadata store", () => {
  it("loads metadata with malformed session entries while scrubbing topology-owned identity fields", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-metadata-store-load-"));
    gitInit(repoRoot);
    await initPaths(repoRoot);
    const paths = getReadOnlyProjectPathsFor(repoRoot);
    writeFileSync(
      paths.metadataPath,
      JSON.stringify({
        version: 1,
        sessions: {
          malformed: null,
          valid: {
            backendSessionId: "backend-1",
            label: "stale-label",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );

    const state = loadMetadataState(repoRoot);

    expect(state.sessions.malformed).toBeNull();
    expect(state.sessions.valid).toEqual({ updatedAt: "2026-01-01T00:00:00.000Z" });

    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("saves metadata with malformed session entries while scrubbing topology-owned identity fields", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-metadata-store-save-"));
    gitInit(repoRoot);
    await initPaths(repoRoot);

    expect(() =>
      saveMetadataState(
        {
          version: 1,
          sessions: {
            malformed: null,
            valid: {
              backendSessionId: "backend-1",
              label: "stale-label",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          },
        } as any,
        repoRoot,
      ),
    ).not.toThrow();

    const state = loadMetadataState(repoRoot);

    expect(state.sessions.malformed).toBeNull();
    expect(state.sessions.valid).toEqual({ updatedAt: "2026-01-01T00:00:00.000Z" });

    rmSync(repoRoot, { recursive: true, force: true });
  });
});
