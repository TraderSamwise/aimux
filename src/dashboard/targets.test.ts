import { describe, expect, it, vi } from "vitest";
import { findLiveDashboardTarget, resolveDashboardTarget } from "./targets.js";
import { getDashboardCommandSpec } from "./command-spec.js";
import type { TmuxRuntimeManager } from "../tmux/runtime-manager.js";
import { getRuntimeOwnerId, TMUX_DASHBOARD_OWNER_OPTION, TMUX_RUNTIME_OWNER_OPTION } from "../runtime-owner.js";

describe("findLiveDashboardTarget", () => {
  it("ignores a current tmux client session from another project", () => {
    const { dashboardBuildStamp } = getDashboardCommandSpec("/Users/sam/cs/glyde-frontend");
    const tmux = {
      getProjectSession: vi.fn(() => ({
        projectRoot: "/Users/sam/cs/glyde-frontend",
        projectId: "glyde",
        sessionName: "aimux-glyde-frontend-abc123",
      })),
      getOpenSessionName: vi.fn(() => "aimux-glyde-frontend-abc123"),
      isInsideTmux: vi.fn(() => true),
      currentClientSession: vi.fn(() => "aimux-tealstreet-next-def456-client-deadbeef"),
      listSessionNames: vi.fn(() => [
        "aimux-glyde-frontend-abc123",
        "aimux-tealstreet-next-def456",
        "aimux-tealstreet-next-def456-client-deadbeef",
      ]),
      hasSession: vi.fn((sessionName: string) => sessionName === "aimux-glyde-frontend-abc123"),
      listWindows: vi.fn((sessionName: string) =>
        sessionName === "aimux-glyde-frontend-abc123"
          ? [{ id: "@1", index: 0, name: "dashboard", active: true }]
          : [{ id: "@2", index: 0, name: "dashboard", active: true }],
      ),
      isWindowAlive: vi.fn(() => true),
      getWindowOption: vi.fn((_target: unknown, key: string) =>
        key === TMUX_DASHBOARD_OWNER_OPTION ? getRuntimeOwnerId() : dashboardBuildStamp,
      ),
      getSessionOption: vi.fn((sessionName: string, key: string) =>
        key === TMUX_RUNTIME_OWNER_OPTION
          ? getRuntimeOwnerId()
          : key === "@aimux-project-root" && sessionName === "aimux-glyde-frontend-abc123"
            ? "/Users/sam/cs/glyde-frontend"
            : "/Users/sam/cs/tealstreet-next",
      ),
      displayMessage: vi.fn(() => "bash"),
      captureTarget: vi.fn(() => ""),
      killWindow: vi.fn(),
    } as unknown as TmuxRuntimeManager;

    const target = findLiveDashboardTarget("/Users/sam/cs/glyde-frontend", tmux);

    expect(target?.dashboardTarget.sessionName).toBe("aimux-glyde-frontend-abc123");
    expect(tmux.listWindows).not.toHaveBeenCalledWith("aimux-tealstreet-next-def456-client-deadbeef");
  });

  it("respawns a dashboard owned by another aimux runtime", () => {
    const { dashboardBuildStamp } = getDashboardCommandSpec("/Users/sam/cs/glyde-frontend");
    const dashboardTarget = {
      sessionName: "aimux-glyde-frontend-abc123",
      windowId: "@1",
      windowIndex: 0,
      windowName: "dashboard",
    };
    const tmux = {
      getProjectSession: vi.fn(() => ({
        projectRoot: "/Users/sam/cs/glyde-frontend",
        projectId: "glyde",
        sessionName: "aimux-glyde-frontend-abc123",
      })),
      getOpenSessionName: vi.fn(() => "aimux-glyde-frontend-abc123"),
      isInsideTmux: vi.fn(() => false),
      currentClientSession: vi.fn(() => null),
      listSessionNames: vi.fn(() => ["aimux-glyde-frontend-abc123"]),
      hasSession: vi.fn(() => true),
      listWindows: vi.fn(() => [{ id: "@1", index: 0, name: "dashboard", active: true }]),
      ensureProjectSession: vi.fn(() => ({
        projectRoot: "/Users/sam/cs/glyde-frontend",
        projectId: "glyde",
        sessionName: "aimux-glyde-frontend-abc123",
      })),
      ensureDashboardWindow: vi.fn(() => dashboardTarget),
      isWindowAlive: vi.fn(() => true),
      getWindowOption: vi.fn((_target: unknown, key: string) =>
        key === TMUX_DASHBOARD_OWNER_OPTION ? "other-owner" : dashboardBuildStamp,
      ),
      getSessionOption: vi.fn((_sessionName: string, key: string) =>
        key === TMUX_RUNTIME_OWNER_OPTION ? "other-owner" : "/Users/sam/cs/glyde-frontend",
      ),
      displayMessage: vi.fn(() => "bash"),
      captureTarget: vi.fn(() => ""),
      killWindow: vi.fn(),
      respawnWindow: vi.fn(),
      setSessionOption: vi.fn(),
      setWindowOption: vi.fn(),
    } as unknown as TmuxRuntimeManager;

    expect(findLiveDashboardTarget("/Users/sam/cs/glyde-frontend", tmux)).toBeNull();

    resolveDashboardTarget("/Users/sam/cs/glyde-frontend", tmux);

    expect(tmux.respawnWindow).toHaveBeenCalledWith(dashboardTarget, expect.any(Object));
    expect(tmux.setSessionOption).toHaveBeenCalledWith(
      "aimux-glyde-frontend-abc123",
      "@aimux-dashboard-build",
      dashboardBuildStamp,
    );
    expect(tmux.setWindowOption).toHaveBeenCalledWith(
      dashboardTarget,
      TMUX_DASHBOARD_OWNER_OPTION,
      getRuntimeOwnerId(),
    );
  });
});
