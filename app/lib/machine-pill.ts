// What the Remote pill says when an account has more than one machine.
//
// The pill already meant "where am I talking to". With one machine that is the
// relay's status; with several it is the host the open project is on, because
// "Remote" stops being an answer the moment there is more than one of them.

import type { RelayMachine } from "@/lib/relay-transport";

export interface MachinePillState {
  // The machine the open project is on, when that is the useful answer.
  label: string | null;
  online: boolean;
  // True when there is a fleet to show, so the pill is worth pressing.
  openable: boolean;
}

export function machinePillState(input: {
  machines: readonly RelayMachine[];
  departedMachineIds: readonly string[];
  currentMachineId: string | null | undefined;
  currentMachineName: string | null | undefined;
}): MachinePillState {
  const fleetSize = new Set([
    ...input.machines.map((machine) => machine.id),
    ...input.departedMachineIds,
  ]).size;
  if (fleetSize < 2) return { label: null, online: true, openable: false };
  const current = input.currentMachineId
    ? input.machines.find((machine) => machine.id === input.currentMachineId)
    : undefined;
  return {
    // A project on a machine the relay no longer reports keeps its name and
    // reads as offline: the host going away is what the pill has to show.
    label: current?.name || input.currentMachineName || input.currentMachineId || null,
    online: Boolean(current),
    openable: true,
  };
}

export interface MachinePanelRow {
  id: string;
  name: string;
  online: boolean;
  projectCount: number;
  current: boolean;
}

export function machinePanelRows(input: {
  machines: readonly RelayMachine[];
  projects: readonly { machineId?: string; machineName?: string }[];
  currentMachineId: string | null | undefined;
}): MachinePanelRow[] {
  const counts = new Map<string, number>();
  const names = new Map<string, string>();
  for (const project of input.projects) {
    if (!project.machineId) continue;
    counts.set(project.machineId, (counts.get(project.machineId) ?? 0) + 1);
    if (project.machineName) names.set(project.machineId, project.machineName);
  }
  const online = new Map(input.machines.map((machine) => [machine.id, machine.name]));
  const ids = new Set([...online.keys(), ...counts.keys()]);
  return [...ids]
    .map<MachinePanelRow>((id) => ({
      id,
      name: online.get(id) || names.get(id) || id,
      online: online.has(id),
      projectCount: counts.get(id) ?? 0,
      current: id === input.currentMachineId,
    }))
    .sort(
      (left, right) =>
        Number(right.online) - Number(left.online) || left.name.localeCompare(right.name),
    );
}
