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

    expect(plannedRoutes).toMatchInlineSnapshot(`[]`);
  });
});
