import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initPaths } from "../paths.js";
import { loadOfflineSessions, resumeOfflineSession } from "./runtime-state.js";

describe("resumeOfflineSession", () => {
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-runtime-state-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("suppresses startup preamble for native offline session resume", () => {
    const createSession = vi.fn();
    const host: any = {
      sessions: [],
      offlineSessions: [{ id: "codex-1" }],
      sessionLabels: new Map(),
      sessionBootstrap: {
        canResumeWithBackendSessionId: vi.fn(() => true),
      },
      getSessionLabel: vi.fn(),
      invalidateDesktopStateSnapshot: vi.fn(),
      saveState: vi.fn(),
      writeStatuslineFile: vi.fn(),
      debug: vi.fn(),
      createSession,
    };

    resumeOfflineSession(host, {
      id: "codex-1",
      command: "codex",
      toolConfigKey: "codex",
      backendSessionId: "native-session",
      args: [],
      worktreePath: repoRoot,
    });

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0]).toMatchObject([
      "codex",
      expect.arrayContaining(["resume", "native-session"]),
      undefined,
      "codex",
      undefined,
      undefined,
      repoRoot,
      "native-session",
      "codex-1",
      true,
      true,
    ]);
  });

  it("does not reload a starting session as offline from stale saved state", () => {
    const host: any = {
      sessions: [],
      offlineSessions: [],
      getRemoteInstancesSafe: vi.fn(() => []),
      dashboardPendingActions: {
        get: vi.fn((sessionId: string) => (sessionId === "codex-1" ? "starting" : undefined)),
      },
      debug: vi.fn(),
    };

    const changed = loadOfflineSessions(host, {
      sessions: [
        {
          id: "codex-1",
          command: "codex",
          tool: "codex",
          toolConfigKey: "codex",
          args: [],
          backendSessionId: "native-session",
          worktreePath: repoRoot,
        },
      ],
      services: [],
      updatedAt: new Date().toISOString(),
    });

    expect(changed).toBe(false);
    expect(host.offlineSessions).toEqual([]);
  });
});
