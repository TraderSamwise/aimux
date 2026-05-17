import { describe, expect, it } from "vitest";

import {
  applyDashboardOrder,
  dashboardOrderKey,
  MAIN_CHECKOUT_ORDER_KEY,
  moveDashboardOrder,
  normalizeDashboardOrder,
  orderDashboardWorktreeGroups,
} from "./order.js";

describe("dashboard order helpers", () => {
  it("uses a stable key for main checkout", () => {
    expect(dashboardOrderKey(undefined)).toBe(MAIN_CHECKOUT_ORDER_KEY);
    expect(dashboardOrderKey("/repo/.aimux/worktrees/demo")).toBe("/repo/.aimux/worktrees/demo");
  });

  it("normalizes stale saved ids and appends new ids in current order", () => {
    expect(normalizeDashboardOrder(["a", "b", "c"], ["b", "missing", "b", "a"])).toEqual(["b", "a", "c"]);
  });

  it("applies saved order without mutating the input list", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(applyDashboardOrder(items, ["c", "a"]).map((item) => item.id)).toEqual(["c", "a", "b"]);
    expect(items.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("moves selected ids within the current peer list only", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(moveDashboardOrder(items, ["c", "a", "b"], "a", "down")).toEqual({
      moved: true,
      order: ["c", "b", "a"],
    });
    expect(moveDashboardOrder(items, ["c", "a", "b"], "c", "up")).toEqual({
      moved: false,
      order: ["c", "a", "b"],
    });
  });

  it("orders agents and services separately inside each worktree", () => {
    const groups = orderDashboardWorktreeGroups(
      [
        {
          name: "Main Checkout",
          branch: "master",
          path: undefined,
          status: "active",
          sessions: [{ id: "agent-a" }, { id: "agent-b" }] as any,
          services: [{ id: "service-a" }, { id: "service-b" }] as any,
        },
      ],
      {
        agentOrderByWorktreeKey: { [MAIN_CHECKOUT_ORDER_KEY]: ["agent-b", "agent-a"] },
        serviceOrderByWorktreeKey: { [MAIN_CHECKOUT_ORDER_KEY]: ["service-b", "service-a"] },
      },
    );

    expect(groups[0]?.sessions.map((session) => session.id)).toEqual(["agent-b", "agent-a"]);
    expect(groups[0]?.services.map((service) => service.id)).toEqual(["service-b", "service-a"]);
  });
});
