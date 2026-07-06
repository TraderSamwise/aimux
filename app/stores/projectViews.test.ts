import { describe, expect, it } from "vitest";

import { PROJECT_API_VIEWS, type ProjectApiView } from "../../src/project-api-contract";
import {
  APP_PROJECT_API_VIEW_REGISTRY,
  projectUpdateTouchesDesktopState,
  projectUpdateTouchesNotificationFeed,
  projectUpdateTouchesProjectApiView,
} from "./projectViews";

describe("project API view refresh registry", () => {
  it("classifies every shared project API view", () => {
    expect(Object.keys(APP_PROJECT_API_VIEW_REGISTRY).sort()).toEqual(
      [...PROJECT_API_VIEWS].sort(),
    );
  });

  it("keeps refresh dependencies explicit", () => {
    const byFlag = (flag: keyof (typeof APP_PROJECT_API_VIEW_REGISTRY)[ProjectApiView]) =>
      Object.entries(APP_PROJECT_API_VIEW_REGISTRY)
        .filter(([, refresh]) => refresh[flag])
        .map(([view]) => view)
        .sort();

    expect(byFlag("projectApiViews")).toMatchInlineSnapshot(`
      [
        "agents",
        "coordination-worklist",
        "desktop-state",
        "graveyard",
        "library",
        "notifications",
        "project-observability",
        "services",
        "tasks",
        "team",
        "threads",
        "topology",
        "worktrees",
      ]
    `);
    expect(byFlag("desktopState")).toMatchInlineSnapshot(`
      [
        "agents",
        "desktop-state",
        "services",
        "worktrees",
      ]
    `);
    expect(byFlag("notificationFeed")).toEqual(["notifications"]);
  });

  it("routes project update events to the right refresh channels", () => {
    expect(projectUpdateTouchesProjectApiView(["notifications"])).toBe(true);
    expect(projectUpdateTouchesDesktopState(["notifications"])).toBe(false);
    expect(projectUpdateTouchesNotificationFeed(["notifications"])).toBe(true);

    expect(projectUpdateTouchesProjectApiView(["agents", "services"])).toBe(true);
    expect(projectUpdateTouchesDesktopState(["agents", "services"])).toBe(true);
    expect(projectUpdateTouchesNotificationFeed(["agents", "services"])).toBe(false);
  });

  it("tolerates unknown project update views from skewed services", () => {
    expect(projectUpdateTouchesProjectApiView(["future-view"])).toBe(true);
    expect(projectUpdateTouchesDesktopState(["future-view"])).toBe(false);
    expect(projectUpdateTouchesNotificationFeed(["future-view"])).toBe(false);
  });
});
