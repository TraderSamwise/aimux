import { describe, expect, it } from "vitest";

import type { DaemonProject } from "@/lib/api";
import { filterProjectPickerProjects } from "@/lib/project-picker";

function project(
  input: Partial<DaemonProject> & Pick<DaemonProject, "id" | "name">,
): DaemonProject {
  return {
    dashboardSessionName: `aimux-${input.id}`,
    path: `/repo/${input.id}`,
    service: null,
    serviceAlive: true,
    serviceEndpoint: { host: "127.0.0.1", port: 43190 },
    ...input,
  };
}

describe("filterProjectPickerProjects", () => {
  it("defaults to projects with known online agents", () => {
    const projects = [
      project({ id: "active", name: "active", onlineAgentCount: 2 }),
      project({ id: "empty", name: "empty", onlineAgentCount: 0 }),
      project({ id: "unknown", name: "unknown" }),
    ];

    expect(
      filterProjectPickerProjects(projects, { showAll: false }).map((entry) => entry.id),
    ).toEqual(["active", "unknown"]);
  });

  it("can show every project", () => {
    const projects = [
      project({ id: "active", name: "active", onlineAgentCount: 1 }),
      project({ id: "empty", name: "empty", onlineAgentCount: 0 }),
    ];

    expect(
      filterProjectPickerProjects(projects, { showAll: true }).map((entry) => entry.id),
    ).toEqual(["active", "empty"]);
  });
});
