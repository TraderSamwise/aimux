import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initPaths } from "../paths.js";
import { dashboardTailMethods } from "./dashboard-tail-methods.js";

describe("dashboardTailMethods.takeoverSession", () => {
  it("does not take over sessions from instance registry refs", async () => {
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

    expect(host.instanceDirectory.claimSession).not.toHaveBeenCalled();
    expect(host.createSession).not.toHaveBeenCalled();
    expect(host.renderDashboard).not.toHaveBeenCalled();

    rmSync(repoRoot, { recursive: true, force: true });
  });
});
