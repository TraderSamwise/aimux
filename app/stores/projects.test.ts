import { createStore } from "jotai";
import { describe, expect, it } from "vitest";

import type { DaemonProject } from "@/lib/api";
import { projectKey } from "@/lib/project-key";
import { getProjectServiceEndpoint } from "@/lib/project-connection-display";
import {
  explicitProjectSelectionAtom,
  projectsAtom,
  reconcileProjectsAtom,
  rememberedProjectViewPath,
  rememberProjectViewPath,
  selectedProjectKeyAtom,
  selectedProjectAtom,
  selectedProjectPathAtom,
  selectedProjectRefAtom,
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
    store.set(selectedProjectRefAtom, { path: "/thegrand" });
    store.set(selectedSessionIdAtom, "claude-1");
    store.set(explicitProjectSelectionAtom, {
      key: projectKey({ path: "/thegrand" })!,
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
    store.set(selectedProjectRefAtom, { path: "/tealstreet-next" });
    store.set(selectedSessionIdAtom, "claude-1");

    store.set(reconcileProjectsAtom, []);

    expect(store.get(projectsAtom)).toEqual([]);
    expect(store.get(selectedProjectPathAtom)).toBeNull();
    expect(store.get(selectedSessionIdAtom)).toBeNull();
  });

  it("records a short explicit-selection guard when the user picks a project", () => {
    const store = createStore();
    const before = Date.now();

    store.set(selectProjectAtom, { path: "/thegrand" });

    expect(store.get(selectedProjectPathAtom)).toBe("/thegrand");
    expect(store.get(selectedSessionIdAtom)).toBeNull();
    expect(store.get(explicitProjectSelectionAtom)).toMatchObject({
      key: projectKey({ path: "/thegrand" }),
    });
    expect(store.get(explicitProjectSelectionAtom)?.expiresAt ?? 0).toBeGreaterThan(before);
  });

  it("keeps per-project view memory in process only", () => {
    rememberProjectViewPath({ path: "/thegrand" }, "/agent/claude-1/chat?project=%2Fthegrand");
    rememberProjectViewPath({ path: "/aimux" }, "/project?project=%2Faimux&section=queue");

    expect(rememberedProjectViewPath({ path: "/thegrand" })).toBe(
      "/agent/claude-1/chat?project=%2Fthegrand",
    );
    expect(rememberedProjectViewPath({ path: "/aimux" })).toBe(
      "/project?project=%2Faimux&section=queue",
    );
    expect(rememberedProjectViewPath({ path: "/missing" })).toBeNull();
  });

  // The same checkout on two machines is two projects. The view you had open
  // on strix's copy is not the one you had open on the mbp's.
  it("keeps per-project view memory apart for two machines", () => {
    rememberProjectViewPath({ machineId: "mbp", path: "/shared-path" }, "/project?section=queue");
    rememberProjectViewPath({ machineId: "strix", path: "/shared-path" }, "/topology");

    expect(rememberedProjectViewPath({ machineId: "mbp", path: "/shared-path" })).toBe(
      "/project?section=queue",
    );
    expect(rememberedProjectViewPath({ machineId: "strix", path: "/shared-path" })).toBe(
      "/topology",
    );
    expect(rememberedProjectViewPath({ path: "/shared-path" })).toBeNull();
  });
});

describe("reconciling a project list that is missing a machine", () => {
  // A machine that did not answer has not lost its projects. Dropping them
  // would empty part of the list every time one host blinked.
  it("keeps the projects of a machine that did not answer", () => {
    const store = createStore();
    store.set(reconcileProjectsAtom, [
      machineProject("aimux", "mbp", "sam-mbp"),
      machineProject("tealstreet-next", "strix", "sam-strix"),
    ]);

    store.set(reconcileProjectsAtom, [machineProject("aimux", "mbp", "sam-mbp")], {
      unansweredMachineIds: ["strix"],
    });

    expect(store.get(projectsAtom).map((project) => [project.id, project.machineId])).toEqual([
      ["aimux", "mbp"],
      ["tealstreet-next", "strix"],
    ]);
  });

  // The machine answered, so its list is authoritative: a removed project is
  // removed, not retained forever.
  it("drops a project the answering machine no longer has", () => {
    const store = createStore();
    store.set(reconcileProjectsAtom, [
      machineProject("aimux", "mbp", "sam-mbp"),
      machineProject("sblr", "mbp", "sam-mbp"),
    ]);

    store.set(reconcileProjectsAtom, [machineProject("aimux", "mbp", "sam-mbp")], {
      unansweredMachineIds: ["strix"],
    });

    expect(store.get(projectsAtom).map((project) => project.id)).toEqual(["aimux"]);
  });

  // The host did not answer, so whether a dashboard is running there is
  // unknown. Keeping the green dot and the agent count would be the list
  // telling Sam a machine that is away has live agents on it.
  it("keeps the project but not its liveness", () => {
    const store = createStore();
    store.set(reconcileProjectsAtom, [
      {
        ...machineProject("tealstreet", "strix", "sam-strix"),
        dashboardAlive: true,
        onlineAgentCount: 4,
      },
    ]);

    store.set(reconcileProjectsAtom, [], { unansweredMachineIds: ["strix"] });

    const kept = store.get(projectsAtom)[0];
    expect(kept).toMatchObject({
      id: "tealstreet",
      machineId: "strix",
      serviceAlive: false,
      service: null,
    });
    expect(kept.dashboardAlive).toBeUndefined();
    expect(kept.onlineAgentCount).toBeUndefined();
    // No endpoint, so nothing tries to call a machine that is not there.
    expect(getProjectServiceEndpoint(kept)).toBeNull();
  });

  it("keeps nothing when no machine is named as unanswered", () => {
    const store = createStore();
    store.set(reconcileProjectsAtom, [machineProject("aimux", "mbp", "sam-mbp")]);
    store.set(reconcileProjectsAtom, []);
    expect(store.get(projectsAtom)).toEqual([]);
  });
});

function machineProject(id: string, machineId: string, machineName: string): DaemonProject {
  return {
    id,
    name: id,
    path: `/repo/${id}`,
    machineId,
    machineName,
    dashboardSessionName: `aimux-${id}`,
    service: null,
    serviceAlive: true,
    serviceEndpoint: null,
  };
}

// Contradictory input: the machine both answered and was reported unanswered.
// Retaining its old projects beside its new ones would double the list.
describe("a machine that both answered and was named as unanswered", () => {
  it("trusts the answer and does not duplicate its projects", () => {
    const store = createStore();
    store.set(reconcileProjectsAtom, [
      machineProject("aimux", "mbp", "sam-mbp"),
      machineProject("sblr", "mbp", "sam-mbp"),
    ]);

    store.set(reconcileProjectsAtom, [machineProject("aimux", "mbp", "sam-mbp")], {
      unansweredMachineIds: ["mbp"],
    });

    expect(store.get(projectsAtom).map((project) => project.id)).toEqual(["aimux"]);
  });
});

describe("selecting a project when two machines hold the same path", () => {
  function fleet() {
    return [
      machineProject("aimux", "mbp", "sam-mbp"),
      machineProject("aimux", "strix", "sam-strix"),
    ];
  }

  // The whole reason a project is identified by a pair. Both of these have
  // path /repo/aimux and id "aimux".
  it("selects the one on the machine that was picked", () => {
    const store = createStore();
    store.set(projectsAtom, fleet());

    store.set(selectProjectAtom, { machineId: "strix", path: "/repo/aimux" });

    expect(store.get(selectedProjectAtom)?.machineName).toBe("sam-strix");
    expect(store.get(selectedProjectPathAtom)).toBe("/repo/aimux");
  });

  // A stored selection that names a machine never falls back to the other
  // machine's project of the same name.
  it("selects nothing when the named machine is gone", () => {
    const store = createStore();
    store.set(projectsAtom, [machineProject("aimux", "mbp", "sam-mbp")]);
    store.set(selectedProjectRefAtom, { machineId: "strix", path: "/repo/aimux" });

    expect(store.get(selectedProjectAtom)).toBeNull();
  });

  // Written before machines existed, when there was only one. It means "that
  // path"; with two machines, which was meant is unknowable.
  it("honours a machineless stored selection only when one machine has the path", () => {
    const one = createStore();
    one.set(projectsAtom, [machineProject("aimux", "mbp", "sam-mbp")]);
    one.set(selectedProjectRefAtom, { path: "/repo/aimux" });
    expect(one.get(selectedProjectAtom)?.machineName).toBe("sam-mbp");

    const two = createStore();
    two.set(projectsAtom, fleet());
    two.set(selectedProjectRefAtom, { path: "/repo/aimux" });
    expect(two.get(selectedProjectAtom)).toBeNull();
  });

  // So the next reload does not depend on the fallback.
  it("upgrades a machineless stored selection on the next reconcile", () => {
    const store = createStore();
    store.set(selectedProjectRefAtom, { path: "/repo/aimux" });

    store.set(reconcileProjectsAtom, [machineProject("aimux", "mbp", "sam-mbp")]);

    expect(store.get(selectedProjectRefAtom)).toEqual({ machineId: "mbp", path: "/repo/aimux" });
  });

  it("keeps a selection whose machine is still in the list", () => {
    const store = createStore();
    store.set(projectsAtom, fleet());
    store.set(selectedProjectRefAtom, { machineId: "strix", path: "/repo/aimux" });
    store.set(selectedSessionIdAtom, "claude-1");

    store.set(reconcileProjectsAtom, fleet());

    expect(store.get(selectedProjectRefAtom)).toEqual({ machineId: "strix", path: "/repo/aimux" });
    expect(store.get(selectedSessionIdAtom)).toBe("claude-1");
  });

  it("moves the selection on when that machine's project is gone", () => {
    const store = createStore();
    store.set(projectsAtom, fleet());
    store.set(selectedProjectRefAtom, { machineId: "strix", path: "/repo/aimux" });
    store.set(selectedSessionIdAtom, "claude-1");

    store.set(reconcileProjectsAtom, [machineProject("aimux", "mbp", "sam-mbp")]);

    expect(store.get(selectedProjectRefAtom)).toEqual({ machineId: "mbp", path: "/repo/aimux" });
    expect(store.get(selectedSessionIdAtom)).toBeNull();
  });

  // A bare path is what a build from before machines existed persisted.
  it("reads a stored bare path as a machineless selection", () => {
    const store = createStore();
    store.set(selectedProjectKeyAtom, "/repo/aimux");
    expect(store.get(selectedProjectRefAtom)).toEqual({ path: "/repo/aimux" });
  });
});
