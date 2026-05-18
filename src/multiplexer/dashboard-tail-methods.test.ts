import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initPaths } from "../paths.js";
import { dashboardTailMethods } from "./dashboard-tail-methods.js";

describe("dashboardTailMethods.takeoverSession", () => {
  it("preserves the claimed aimux session id and exact backend session id", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-takeover-"));
    execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
    await initPaths(repoRoot);

    const host: any = {
      instanceDirectory: {
        claimSession: vi.fn(async () => ({
          id: "claude-remote",
          tool: "claude",
          backendSessionId: "backend-remote",
          worktreePath: repoRoot,
        })),
      },
      sessionBootstrap: {
        canResumeWithBackendSessionId: vi.fn(() => true),
        composeToolArgs: vi.fn((_toolCfg, args) => args),
      },
      createSession: vi.fn(),
      renderDashboard: vi.fn(),
    };

    await dashboardTailMethods.takeoverSession.call(host, {
      id: "claude-remote",
      tool: "claude",
      backendSessionId: "backend-remote",
      fromInstanceId: "inst-other",
    });

    expect(host.createSession).toHaveBeenCalledTimes(1);
    expect(host.createSession.mock.calls[0]).toMatchObject([
      "claude",
      expect.arrayContaining(["--resume", "backend-remote"]),
      expect.any(Array),
      "claude",
      undefined,
      undefined,
      repoRoot,
      "backend-remote",
      "claude-remote",
      false,
      true,
    ]);

    rmSync(repoRoot, { recursive: true, force: true });
  });
});
