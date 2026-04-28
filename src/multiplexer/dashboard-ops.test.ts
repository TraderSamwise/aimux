import { describe, expect, it, vi } from "vitest";
import { resumeOfflineServiceWithFeedback } from "./dashboard-ops.js";

describe("dashboard-ops", () => {
  it("shows optimistic starting state and clears it on successful service resume", async () => {
    const host = {
      dashboardPendingActions: new Map<string, string | null>(),
      setPendingDashboardSessionAction(sessionId: string, kind: string | null) {
        this.dashboardPendingActions.set(sessionId, kind);
      },
      footerFlash: "",
      footerFlashTicks: 0,
      renderDashboard: vi.fn(),
      resumeOfflineServiceById: vi.fn(),
      refreshLocalDashboardModel: vi.fn(),
      showDashboardError: vi.fn(),
    };

    await resumeOfflineServiceWithFeedback(host, { id: "svc-1", label: "shell" });

    expect(host.resumeOfflineServiceById).toHaveBeenCalledWith("svc-1");
    expect(host.dashboardPendingActions.get("svc-1")).toBeNull();
    expect(host.footerFlash).toBe("◆ Started service shell");
    expect(host.footerFlashTicks).toBe(3);
    expect(host.renderDashboard).toHaveBeenCalledTimes(2);
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("refreshes local state and shows a dashboard error when service resume fails", async () => {
    const host = {
      dashboardPendingActions: new Map<string, string | null>(),
      setPendingDashboardSessionAction(sessionId: string, kind: string | null) {
        this.dashboardPendingActions.set(sessionId, kind);
      },
      footerFlash: "",
      footerFlashTicks: 0,
      renderDashboard: vi.fn(),
      resumeOfflineServiceById: vi.fn(() => {
        throw new Error("boom");
      }),
      refreshLocalDashboardModel: vi.fn(),
      showDashboardError: vi.fn(),
    };

    await resumeOfflineServiceWithFeedback(host, { id: "svc-1", label: "shell" });

    expect(host.dashboardPendingActions.get("svc-1")).toBeNull();
    expect(host.refreshLocalDashboardModel).toHaveBeenCalledOnce();
    expect(host.showDashboardError).toHaveBeenCalledWith("Failed to start service", ["boom"]);
  });
});
