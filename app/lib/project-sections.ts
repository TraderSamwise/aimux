// How the project list is grouped by machine.
//
// Derived once here so the picker renders what it is given. A switcher would
// hide two thirds of the fleet, which is the opposite of what having three
// machines is for, so every machine is a section and all of them are visible.

import type { DaemonProject } from "@/lib/api";
import type { RelayMachine } from "@/lib/relay-transport";

export interface ProjectSection {
  // Absent for the unlabelled group: local mode, a shared surface, or a relay
  // that has not named the fleet.
  machineId?: string;
  machineName: string;
  // From the relay's machine list, never inferred from the projects. A machine
  // whose projects all look idle is not an offline machine.
  online: boolean;
  // The rows to render, after the Active/All filter.
  projects: DaemonProject[];
  // Every project on that machine, filter or no filter. The header and the
  // machine panel both show this, so one host cannot read as "3" in the list
  // and "5 projects" in the panel.
  totalProjects: number;
}

export function groupProjectsByMachine(
  projects: readonly DaemonProject[],
  machines: readonly RelayMachine[],
  // The list before the Active/All filter, so a header's count is about the
  // machine rather than about what the filter left.
  allProjects: readonly DaemonProject[] = projects,
): ProjectSection[] {
  const online = new Map(machines.map((machine) => [machine.id, machine.name]));
  const totalByMachine = new Map<string, number>();
  for (const project of allProjects) {
    if (!project.machineId) continue;
    totalByMachine.set(project.machineId, (totalByMachine.get(project.machineId) ?? 0) + 1);
  }
  const byMachine = new Map<string, DaemonProject[]>();
  const machineless: DaemonProject[] = [];
  const lastKnownNames = new Map<string, string>();

  for (const project of projects) {
    if (!project.machineId) {
      machineless.push(project);
      continue;
    }
    const existing = byMachine.get(project.machineId);
    if (existing) existing.push(project);
    else byMachine.set(project.machineId, [project]);
    if (project.machineName) lastKnownNames.set(project.machineId, project.machineName);
  }

  // Every connected machine gets a section even with nothing on it: "strix is
  // up and has no projects" is an answer, and an absent section reads as a
  // machine that is not there.
  const machineIds = new Set([...online.keys(), ...byMachine.keys()]);
  const sections = [...machineIds].map<ProjectSection>((machineId) => ({
    machineId,
    machineName: online.get(machineId) || lastKnownNames.get(machineId) || machineId,
    online: online.has(machineId),
    projects: sortProjectsByName(byMachine.get(machineId) ?? []),
    totalProjects: totalByMachine.get(machineId) ?? 0,
  }));

  // Connected machines first, then the ones that are away, each by name, so
  // the list does not reorder as hosts come and go.
  sections.sort(
    (left, right) =>
      Number(right.online) - Number(left.online) ||
      left.machineName.localeCompare(right.machineName),
  );

  if (machineless.length > 0) {
    sections.push({
      machineName: "",
      online: true,
      projects: sortProjectsByName(machineless),
      totalProjects: allProjects.filter((project) => !project.machineId).length,
    });
  }
  return sections;
}

// Within a section, so the same project name on two machines does not
// interleave the two hosts' rows.
function sortProjectsByName(projects: readonly DaemonProject[]): DaemonProject[] {
  return [...projects].sort(
    (left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path),
  );
}

// One unlabelled group is local mode, a shared surface, or a single machine the
// relay never named. Headers there would be chrome around a list of one thing.
export function shouldShowMachineSections(sections: readonly ProjectSection[]): boolean {
  return sections.length > 1 || Boolean(sections[0]?.machineId);
}
