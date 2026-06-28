import { describe, expect, it } from "vitest";

import type { DaemonProject } from "@/lib/api";
import { reconcileProjectList } from "./projects";

function project(input: Partial<DaemonProject> & Pick<DaemonProject, "id" | "name" | "path">) {
  return {
    dashboardSessionName: `aimux-${input.id}`,
    lastSeen: "2026-01-01T00:00:00.000Z",
    service: null,
    serviceAlive: true,
    serviceEndpoint: { host: "127.0.0.1", port: 43190 },
    ...input,
  } satisfies DaemonProject;
}

describe("reconcileProjectList", () => {
  it("preserves the previous array when the daemon snapshot is unchanged", () => {
    const previous = [project({ id: "b", name: "Beta", path: "/repo/b" })];
    const incoming = [project({ id: "b", name: "Beta", path: "/repo/b" })];

    expect(reconcileProjectList(previous, incoming)).toBe(previous);
  });

  it("returns a sorted replacement when project content changes", () => {
    const previous = [project({ id: "b", name: "Beta", path: "/repo/b" })];
    const incoming = [
      project({ id: "b", name: "Beta", path: "/repo/b" }),
      project({ id: "a", name: "Alpha", path: "/repo/a" }),
    ];

    const next = reconcileProjectList(previous, incoming);
    expect(next).not.toBe(previous);
    expect(next.map((entry) => entry.name)).toEqual(["Alpha", "Beta"]);
  });

  it("sorts duplicate project names by stable project identity", () => {
    const incoming = [
      project({ id: "z", name: "Same", path: "/repo/z" }),
      project({ id: "a", name: "Same", path: "/repo/a" }),
      project({ id: "b", name: "Same", path: "/repo/a" }),
    ];

    const next = reconcileProjectList([], incoming);

    expect(next.map((entry) => entry.id)).toEqual(["a", "b", "z"]);
  });
});
