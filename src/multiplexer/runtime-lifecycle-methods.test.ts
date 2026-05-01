import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getStatePath, initPaths } from "../paths.js";
import { runtimeLifecycleMethods } from "./runtime-lifecycle-methods.js";

describe("runtime lifecycle state persistence", () => {
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-runtime-lifecycle-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function host(overrides: Record<string, unknown> = {}) {
    return {
      sessions: [],
      offlineSessions: [],
      offlineServices: [],
      sessionToolKeys: new Map(),
      sessionOriginalArgs: new Map(),
      sessionWorktreePaths: new Map(),
      sessionTmuxTargets: new Map(),
      buildLiveServiceStates: vi.fn(() => []),
      getRemoteInstancesSafe: vi.fn(() => []),
      invalidateDesktopStateSnapshot: vi.fn(),
      ...overrides,
    };
  }

  it("persists an empty state after the last local row is removed", () => {
    writeFileSync(
      getStatePath(),
      JSON.stringify(
        {
          savedAt: new Date().toISOString(),
          cwd: repoRoot,
          sessions: [{ id: "stale-agent", command: "codex", tool: "codex", args: [] }],
          services: [{ id: "stale-service", command: "shell", args: [] }],
        },
        null,
        2,
      ) + "\n",
    );

    runtimeLifecycleMethods.saveState.call(host() as never);

    const saved = JSON.parse(readFileSync(getStatePath(), "utf-8")) as { sessions: unknown[]; services: unknown[] };
    expect(saved.sessions).toEqual([]);
    expect(saved.services).toEqual([]);
  });

  it("does not erase live remote sessions when this instance has no local rows", () => {
    writeFileSync(
      getStatePath(),
      JSON.stringify(
        {
          savedAt: new Date().toISOString(),
          cwd: repoRoot,
          sessions: [{ id: "remote-agent", command: "claude", tool: "claude", args: [] }],
          services: [{ id: "stale-service", command: "shell", args: [] }],
        },
        null,
        2,
      ) + "\n",
    );

    runtimeLifecycleMethods.saveState.call(
      host({
        getRemoteInstancesSafe: vi.fn(() => [
          {
            instanceId: "remote",
            pid: 123,
            cwd: repoRoot,
            updatedAt: new Date().toISOString(),
            sessions: [{ id: "remote-agent", tool: "claude" }],
          },
        ]),
      }) as never,
    );

    const saved = JSON.parse(readFileSync(getStatePath(), "utf-8")) as {
      sessions: Array<{ id: string }>;
      services: Array<{ id: string }>;
    };
    expect(saved.sessions.map((session) => session.id)).toEqual(["remote-agent"]);
    expect(saved.services).toEqual([]);
  });
});
