import { describe, expect, it, vi } from "vitest";
import { findLiveDashboardTarget } from "./targets.js";
import { getDashboardCommandSpec } from "./command-spec.js";
import type { TmuxRuntimeManager } from "../tmux/runtime-manager.js";

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
      getWindowOption: vi.fn(() => dashboardBuildStamp),
      getSessionOption: vi.fn((sessionName: string, key: string) =>
        key === "@aimux-project-root" && sessionName === "aimux-glyde-frontend-abc123"
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
});
