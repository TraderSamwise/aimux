import { describe, expect, it } from "vitest";

import type { DaemonProject } from "@/lib/api";
import {
  filterProjectPickerProjects,
  isProjectOnline,
  projectOnlineState,
} from "@/lib/project-picker";

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

// Sam's rule: a project is online when a tmux dashboard is running on it. This
// used to read `serviceAlive`, the project-service process, which is a different
// fact that only happened to agree.
describe("isProjectOnline", () => {
  it("follows the dashboard, not the project service", () => {
    expect(isProjectOnline(project({ id: "a", name: "a", dashboardAlive: true }))).toBe(true);
    expect(
      isProjectOnline(project({ id: "b", name: "b", serviceAlive: true, dashboardAlive: false })),
    ).toBe(false);
    expect(
      isProjectOnline(project({ id: "c", name: "c", serviceAlive: false, dashboardAlive: true })),
    ).toBe(true);
  });

  it("does not call unknown liveness online", () => {
    expect(isProjectOnline(project({ id: "d", name: "d", serviceAlive: true }))).toBe(false);
  });
});

describe("filterProjectPickerProjects", () => {
  it("hides only the projects with no dashboard in active mode", () => {
    const projects = [
      project({ id: "open", name: "open", dashboardAlive: true }),
      project({ id: "closed", name: "closed", dashboardAlive: false }),
      project({
        id: "service-only",
        name: "service-only",
        serviceAlive: true,
        dashboardAlive: false,
      }),
    ];

    expect(
      filterProjectPickerProjects(projects, { showAll: false }).map((entry) => entry.id),
    ).toEqual(["open"]);
  });

  // A daemon that could not ask tmux, or one predating the field, reports unknown
  // for every project. Hiding those would empty the picker and read as "you have
  // no projects" -- the failure this whole change exists to stop.
  it("keeps projects whose liveness is unknown", () => {
    const unknown = [
      project({ id: "unknown-a", name: "unknown-a" }),
      project({ id: "unknown-b", name: "unknown-b", serviceAlive: false }),
    ];

    expect(
      filterProjectPickerProjects(unknown, { showAll: false }).map((entry) => entry.id),
    ).toEqual(["unknown-a", "unknown-b"]);
  });

  it("includes everything in all mode", () => {
    const projects = [
      project({ id: "open", name: "open", dashboardAlive: true }),
      project({ id: "closed", name: "closed", dashboardAlive: false }),
    ];

    expect(
      filterProjectPickerProjects(projects, { showAll: true }).map((entry) => entry.id),
    ).toEqual(["open", "closed"]);
  });
});

// The row renders this, and folding unknown into offline is how a failed tmux
// sample would tell Sam every project is dead while the filter kept it visible.
describe("projectOnlineState", () => {
  it("keeps unknown apart from offline", () => {
    expect(projectOnlineState(project({ id: "a", name: "a", dashboardAlive: true }))).toBe(
      "online",
    );
    expect(projectOnlineState(project({ id: "b", name: "b", dashboardAlive: false }))).toBe(
      "offline",
    );
    expect(projectOnlineState(project({ id: "c", name: "c", serviceAlive: true }))).toBe("unknown");
  });
});
