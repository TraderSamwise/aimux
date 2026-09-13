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
  it("defaults to projects with a live service", () => {
    const projects = [
      project({ id: "active", name: "active", onlineAgentCount: 2, serviceAlive: true }),
      project({ id: "empty", name: "empty", onlineAgentCount: 0, serviceAlive: true }),
      project({
        id: "offline-with-stale-count",
        name: "offline-with-stale-count",
        onlineAgentCount: 1,
        serviceAlive: false,
        serviceEndpoint: null,
      }),
      project({ id: "offline", name: "offline", serviceAlive: false, serviceEndpoint: null }),
    ];

    expect(
      filterProjectPickerProjects(projects, { showAll: false }).map((entry) => entry.id),
    ).toEqual(["active", "empty"]);
  });

  it("can show every project", () => {
    const projects = [
      project({ id: "active", name: "active", onlineAgentCount: 1 }),
      project({ id: "offline", name: "offline", serviceAlive: false, serviceEndpoint: null }),
    ];

    expect(
      filterProjectPickerProjects(projects, { showAll: true }).map((entry) => entry.id),
    ).toEqual(["active", "offline"]);
  });
});
