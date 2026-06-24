import { describe, expect, it } from "vitest";
import {
  PROJECT_API_EVENT_NAMES,
  PROJECT_API_ROUTES,
  PROJECT_API_VIEWS,
  type LivePaneAttachRequest,
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
    expect(PROJECT_API_VIEWS).not.toContain("inbox");
    expect(PROJECT_API_VIEWS).not.toContain("plans");
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
