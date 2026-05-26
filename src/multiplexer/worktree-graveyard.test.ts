import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initPaths } from "../paths.js";
import { upsertTopologySession } from "../runtime-core/topology-sessions.js";
import { upsertTopologyService } from "../runtime-core/topology-services.js";
import { moveTopologyWorktreeToGraveyard, upsertTopologyWorktree } from "../runtime-core/topology-worktrees.js";
import { listWorktreeGraveyardEntries } from "./worktree-graveyard.js";

describe("worktree graveyard projection", () => {
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-worktree-graveyard-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("includes attached topology sessions and services in graveyard entries", () => {
    const worktreePath = join(repoRoot, ".aimux/worktrees/demo");
    upsertTopologyWorktree({ path: worktreePath, name: "demo", branch: "demo" }, "active");
    upsertTopologySession(
      { id: "codex-demo", tool: "codex", toolConfigKey: "codex", command: "codex", args: [], worktreePath },
      "offline",
    );
    upsertTopologyService(
      { id: "service-demo", command: "zsh", launchCommandLine: "yarn web", worktreePath },
      "stopped",
    );
    moveTopologyWorktreeToGraveyard(worktreePath);

    expect(listWorktreeGraveyardEntries()).toEqual([
      expect.objectContaining({
        path: worktreePath,
        agents: [expect.objectContaining({ id: "codex-demo", worktreePath })],
        services: [expect.objectContaining({ id: "service-demo", worktreePath })],
      }),
    ]);
  });
});
