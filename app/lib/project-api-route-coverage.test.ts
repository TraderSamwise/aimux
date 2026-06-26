import { describe, expect, it } from "vitest";

import { APP_PROJECT_ROUTE_COVERAGE } from "@/lib/project-api-route-coverage";
import { PROJECT_API_ROUTES } from "../../src/project-api-contract";

function flattenRoutes(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(flattenRoutes);
}

describe("project API route coverage", () => {
  it("classifies every project API route used by the metadata server contract", () => {
    const contractRoutes = flattenRoutes(PROJECT_API_ROUTES).sort();
    const coveredRoutes = Object.keys(APP_PROJECT_ROUTE_COVERAGE).sort();

    expect(coveredRoutes).toEqual(contractRoutes);
  });

  it("keeps parity gaps explicit", () => {
    const plannedRoutes = Object.entries(APP_PROJECT_ROUTE_COVERAGE)
      .filter(([, status]) => status.startsWith("planned-"))
      .map(([route]) => route)
      .sort();

    expect(plannedRoutes).toMatchInlineSnapshot(`
      [
        "/agents",
        "/agents/fork",
        "/agents/history",
        "/agents/interaction/pending",
        "/agents/interaction/respond",
        "/agents/interaction/stream",
        "/agents/kill",
        "/agents/loop",
        "/agents/migrate",
        "/agents/output/stream",
        "/agents/overseer",
        "/agents/rename",
        "/agents/resume",
        "/agents/spawn",
        "/agents/stop",
        "/agents/teammates",
        "/agents/teammates/create",
        "/agents/teammates/kill",
        "/agents/teammates/resume",
        "/agents/teammates/resurrect",
        "/agents/teammates/stop",
        "/agents/teammates/tasks",
        "/control/switchable-agents",
        "/diagnostics",
        "/graveyard/cleanup",
        "/health",
        "/operation-failures/clear",
        "/statusline/refresh",
      ]
    `);
  });
});
