import { describe, expect, it, vi } from "vitest";

import { recordDashboardRepairNotice } from "./repair-notices.js";

describe("recordDashboardRepairNotice", () => {
  it("records without flashing or rendering when the host is outside dashboard mode", () => {
    const host: any = {
      mode: "session",
      renderCurrentDashboardView: vi.fn(),
    };

    recordDashboardRepairNotice(host, {
      kind: "tui-api-recovery",
      phase: "succeeded",
      message: "Aimux API recovery complete",
    });

    expect(host.dashboardRepairNotices).toMatchObject([
      {
        kind: "tui-api-recovery",
        phase: "succeeded",
        message: "Aimux API recovery complete",
      },
    ]);
    expect(host).not.toHaveProperty("footerFlash");
    expect(host.renderCurrentDashboardView).not.toHaveBeenCalled();
  });
});
