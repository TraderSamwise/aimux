import { describe, expect, it } from "vitest";
import { PROJECT_API_EVENT_NAMES, PROJECT_API_ROUTES, PROJECT_API_VIEWS } from "./project-api-contract.js";

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
    expect(PROJECT_API_ROUTES.livePane.attach).toBe("/live-pane/attach");
  });

  it("defines shared SSE event names and API-backed views", () => {
    expect(PROJECT_API_EVENT_NAMES.projectUpdate).toBe("project_update");
    expect(PROJECT_API_EVENT_NAMES.agentOutput).toBe("agent_output");
    expect(PROJECT_API_VIEWS).toContain("coordination-worklist");
    expect(PROJECT_API_VIEWS).toContain("desktop-state");
    expect(PROJECT_API_VIEWS).toContain("notifications");
  });
});
