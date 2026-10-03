import { describe, expect, it } from "vitest";

import type { DaemonProject } from "@/lib/api";
import { groupProjectsByMachine, shouldShowMachineSections } from "./project-sections";

function project(name: string, machineId?: string, machineName?: string): DaemonProject {
  return {
    id: name,
    name,
    path: `/repo/${name}`,
    machineId,
    machineName,
    dashboardSessionName: `aimux-${name}`,
    service: null,
    serviceAlive: true,
    serviceEndpoint: null,
  };
}

const MBP = { id: "mbp", name: "sam-mbp" };
const STRIX = { id: "strix", name: "sam-strix" };

describe("grouping the project list by machine", () => {
  it("gives every connected machine its own section", () => {
    const sections = groupProjectsByMachine(
      [project("aimux", "mbp", "sam-mbp"), project("tealstreet", "strix", "sam-strix")],
      [MBP, STRIX],
    );
    expect(
      sections.map((section) => [section.machineName, section.online, section.projects.length]),
    ).toEqual([
      ["sam-mbp", true, 1],
      ["sam-strix", true, 1],
    ]);
  });

  // Going away is information, not absence. The projects stay, and the section
  // says the host is not there.
  it("keeps an away machine's last-known projects and marks it offline", () => {
    const sections = groupProjectsByMachine(
      [project("aimux", "mbp", "sam-mbp"), project("tealstreet", "strix", "sam-strix")],
      [MBP],
    );
    expect(sections.map((section) => [section.machineName, section.online])).toEqual([
      ["sam-mbp", true],
      ["sam-strix", false],
    ]);
    expect(sections[1].projects.map((entry) => entry.name)).toEqual(["tealstreet"]);
  });

  // "strix is up and has nothing on it" is an answer. No section at all reads
  // as a machine that is not connected.
  it("shows a connected machine with no projects", () => {
    const sections = groupProjectsByMachine([project("aimux", "mbp", "sam-mbp")], [MBP, STRIX]);
    expect(sections.map((section) => [section.machineName, section.projects.length])).toEqual([
      ["sam-mbp", 1],
      ["sam-strix", 0],
    ]);
  });

  it("names an away machine from the projects it left behind", () => {
    const sections = groupProjectsByMachine([project("aimux", "strix", "sam-strix")], []);
    expect(sections[0]).toMatchObject({
      machineId: "strix",
      machineName: "sam-strix",
      online: false,
    });
  });

  it("falls back to the id when nothing ever named the machine", () => {
    const sections = groupProjectsByMachine([project("aimux", "strix")], []);
    expect(sections[0].machineName).toBe("strix");
  });

  it("puts connected machines first, then the rest by name", () => {
    const sections = groupProjectsByMachine(
      [
        project("a", "zeta", "zeta-host"),
        project("b", "alpha", "alpha-host"),
        project("c", "away", "away-host"),
      ],
      [
        { id: "zeta", name: "zeta-host" },
        { id: "alpha", name: "alpha-host" },
      ],
    );
    expect(sections.map((section) => section.machineName)).toEqual([
      "alpha-host",
      "zeta-host",
      "away-host",
    ]);
  });
});

describe("whether the list needs machine headers at all", () => {
  // Local mode, a shared surface, or a relay that never named the fleet.
  // Headers there would be chrome around a list of one thing.
  it("renders flat when nothing is machine-scoped", () => {
    const sections = groupProjectsByMachine([project("aimux"), project("sblr")], []);
    expect(sections).toHaveLength(1);
    expect(sections[0].machineId).toBeUndefined();
    expect(sections[0].projects).toHaveLength(2);
    expect(shouldShowMachineSections(sections)).toBe(false);
  });

  it("renders headers as soon as one machine is named", () => {
    expect(
      shouldShowMachineSections(
        groupProjectsByMachine([project("aimux", "mbp", "sam-mbp")], [MBP]),
      ),
    ).toBe(true);
  });

  it("renders nothing special for an empty list", () => {
    expect(shouldShowMachineSections(groupProjectsByMachine([], []))).toBe(false);
  });
});

describe("what a section header counts", () => {
  // One host must not read as "1" in the list and "2 projects" in the machine
  // panel just because the Active filter hid one of them.
  it("counts every project on the machine, not the rows the filter left", () => {
    const all = [project("aimux", "mbp", "sam-mbp"), project("sblr", "mbp", "sam-mbp")];
    const sections = groupProjectsByMachine([all[0]], [MBP], all);
    expect(sections[0].projects).toHaveLength(1);
    expect(sections[0].totalProjects).toBe(2);
  });

  it("counts the machineless group the same way", () => {
    const all = [project("aimux"), project("sblr")];
    const sections = groupProjectsByMachine([all[0]], [], all);
    expect(sections[0].totalProjects).toBe(2);
  });

  it("defaults to the rows it was given when nothing else is", () => {
    const sections = groupProjectsByMachine([project("aimux", "mbp", "sam-mbp")], [MBP]);
    expect(sections[0].totalProjects).toBe(1);
  });
});
