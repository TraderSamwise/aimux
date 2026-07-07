import { describe, expect, it } from "vitest";
import {
  PROJECT_API_EVENT_NAMES,
  PROJECT_API_ROUTES,
  PROJECT_API_VIEW_INVALIDATIONS,
  PROJECT_API_VIEWS,
  type LivePaneAttachRequest,
  projectApiViewsForMutationRoute,
} from "./project-api-contract.js";

function collectRoutes(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap((entry) => collectRoutes(entry));
}

describe("project api contract", () => {
  it("defines unique absolute routes", () => {
    const routes = collectRoutes(PROJECT_API_ROUTES);
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.every((route) => route.startsWith("/"))).toBe(true);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it("keeps shared TUI/app screen routes stable", () => {
    expect(PROJECT_API_ROUTES.desktopState).toBe("/desktop-state");
    expect(PROJECT_API_ROUTES.coordinationWorklist).toBe("/coordination-worklist");
    expect(PROJECT_API_ROUTES.projectObservability).toBe("/project-observability");
    expect(PROJECT_API_ROUTES.topology).toBe("/topology");
    expect(PROJECT_API_ROUTES.library).toBe("/library");
    expect(PROJECT_API_ROUTES.graveyardActions.resurrectWorktree).toBe("/graveyard/worktrees/resurrect");
    expect(PROJECT_API_ROUTES.livePane.output).toBe("/live-pane/output");
    expect(PROJECT_API_ROUTES.livePane.input).toBe("/live-pane/input");
    expect(PROJECT_API_ROUTES.livePane.interrupt).toBe("/live-pane/interrupt");
    expect(PROJECT_API_ROUTES.livePane.resize).toBe("/live-pane/resize");
    expect(PROJECT_API_ROUTES.livePane.attach).toBe("/live-pane/attach");
  });

  it("defines shared SSE event names and API-backed views", () => {
    expect(PROJECT_API_EVENT_NAMES.projectUpdate).toBe("project_update");
    expect(PROJECT_API_EVENT_NAMES.agentOutput).toBe("agent_output");
    expect(PROJECT_API_VIEWS).toContain("coordination-worklist");
    expect(PROJECT_API_VIEWS).toContain("desktop-state");
    expect(PROJECT_API_VIEWS).toContain("notifications");
    expect(PROJECT_API_VIEWS).toContain("plans");
    expect(PROJECT_API_VIEWS).not.toContain("inbox");
  });

  it("keeps invalidation groups within the shared view set", () => {
    const knownViews = new Set(PROJECT_API_VIEWS);
    for (const views of Object.values(PROJECT_API_VIEW_INVALIDATIONS)) {
      expect(views.length).toBeGreaterThan(0);
      for (const view of views) {
        expect(knownViews.has(view)).toBe(true);
      }
    }
  });

  it("maps mutation routes to shared client invalidations", () => {
    expect(projectApiViewsForMutationRoute("PUT", "/plans/codex-1")).toEqual(["plans"]);
    expect(projectApiViewsForMutationRoute("POST", PROJECT_API_ROUTES.notifications.read)).toEqual([
      "coordination-worklist",
      "notifications",
      "project-observability",
    ]);
    expect(projectApiViewsForMutationRoute("POST", PROJECT_API_ROUTES.agents.spawn)).toEqual([
      "agents",
      "coordination-worklist",
      "desktop-state",
      "graveyard",
      "project-observability",
      "team",
      "topology",
      "worktrees",
    ]);
    expect(projectApiViewsForMutationRoute("POST", PROJECT_API_ROUTES.tasks.assign)).toEqual([
      "coordination-worklist",
      "project-observability",
      "tasks",
      "threads",
    ]);
    expect(projectApiViewsForMutationRoute("GET", PROJECT_API_ROUTES.controls.switchNext)).toEqual([
      "agents",
      "coordination-worklist",
      "desktop-state",
      "project-observability",
      "topology",
      "worktrees",
    ]);
    expect(projectApiViewsForMutationRoute("POST", "/future-mutation")).toEqual([
      "agents",
      "coordination-worklist",
      "desktop-state",
      "project-observability",
      "topology",
      "worktrees",
      "tasks",
      "threads",
    ]);
    expect(projectApiViewsForMutationRoute("GET", PROJECT_API_ROUTES.agents.list)).toBeNull();
  });

  it("requires live pane attach dimensions to be both or neither", () => {
    const withoutResize: LivePaneAttachRequest = { sessionId: "codex-1", startLine: -90 };
    const withResize: LivePaneAttachRequest = { sessionId: "codex-1", cols: 100, rows: 32 };
    // @ts-expect-error attach resize dimensions are a pair
    const missingRows: LivePaneAttachRequest = { sessionId: "codex-1", cols: 100 };

    expect(withoutResize.sessionId).toBe("codex-1");
    expect(withResize.sessionId).toBe("codex-1");
    expect(missingRows.sessionId).toBe("codex-1");
  });
});
