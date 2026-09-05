import { createStore } from "jotai";
import { describe, expect, it } from "vitest";

import type { DaemonProject } from "@/lib/api";
import {
  explicitProjectSelectionAtom,
  projectsAtom,
  reconcileProjectsAtom,
  rememberedProjectViewPath,
  rememberProjectViewPath,
  selectedProjectPathAtom,
  selectedSessionIdAtom,
  selectProjectAtom,
  reconcileProjectList,
} from "@/stores/projects";

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

describe("project selection store", () => {
  it("keeps the selected project during transient empty discovery snapshots", () => {
    const store = createStore();
    store.set(projectsAtom, [
      project({ id: "tealstreet-next", name: "Tealstreet", path: "/tealstreet-next" }),
      project({ id: "thegrand", name: "The Grand", path: "/thegrand" }),
    ]);
    store.set(selectedProjectPathAtom, "/thegrand");
    store.set(selectedSessionIdAtom, "claude-1");
    store.set(explicitProjectSelectionAtom, {
      path: "/thegrand",
      expiresAt: Date.now() + 1000,
    });

    store.set(reconcileProjectsAtom, []);

    expect(store.get(projectsAtom).map((item) => item.path)).toEqual([
      "/tealstreet-next",
      "/thegrand",
    ]);
    expect(store.get(selectedProjectPathAtom)).toBe("/thegrand");
    expect(store.get(selectedSessionIdAtom)).toBe("claude-1");
  });

  it("clears stale selection when discovery really becomes empty", () => {
    const store = createStore();
    store.set(projectsAtom, [
      project({ id: "tealstreet-next", name: "Tealstreet", path: "/tealstreet-next" }),
    ]);
    store.set(selectedProjectPathAtom, "/tealstreet-next");
    store.set(selectedSessionIdAtom, "claude-1");

    store.set(reconcileProjectsAtom, []);

    expect(store.get(projectsAtom)).toEqual([]);
    expect(store.get(selectedProjectPathAtom)).toBeNull();
    expect(store.get(selectedSessionIdAtom)).toBeNull();
  });

  it("records a short explicit-selection guard when the user picks a project", () => {
    const store = createStore();
    const before = Date.now();

    store.set(selectProjectAtom, "/thegrand");

    expect(store.get(selectedProjectPathAtom)).toBe("/thegrand");
    expect(store.get(selectedSessionIdAtom)).toBeNull();
    expect(store.get(explicitProjectSelectionAtom)).toMatchObject({ path: "/thegrand" });
    expect(store.get(explicitProjectSelectionAtom)?.expiresAt ?? 0).toBeGreaterThan(before);
  });

  it("keeps per-project view memory in process only", () => {
    rememberProjectViewPath("/thegrand", "/agent/claude-1/chat?project=%2Fthegrand");
    rememberProjectViewPath("/aimux", "/project?project=%2Faimux&section=queue");

    expect(rememberedProjectViewPath("/thegrand")).toBe("/agent/claude-1/chat?project=%2Fthegrand");
    expect(rememberedProjectViewPath("/aimux")).toBe("/project?project=%2Faimux&section=queue");
    expect(rememberedProjectViewPath("/missing")).toBeNull();
  });
});
