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
  // True when there is a fleet to show, so the pill is worth pressing. A
  // screen with no project open -- Monitor, an empty selection -- still has a
  // fleet to show, so the panel is reachable there too.
  openable: boolean;
}

export function machinePillState(input: {
  machines: readonly RelayMachine[];
  // The rows the panel will show. The pill's own count is taken from them so
  // it cannot say "3 machines" over a list of two -- a departed machine with
  // nothing on it is counted by neither.
  panelRows: readonly MachinePanelRow[];
  currentMachineId: string | null | undefined;
  currentMachineName: string | null | undefined;
}): MachinePillState {
  const fleetSize = input.panelRows.length;
  if (fleetSize < 2) return { label: null, online: true, openable: false };
  const current = input.currentMachineId
    ? input.machines.find((machine) => machine.id === input.currentMachineId)
    : undefined;
  const label = current?.name || input.currentMachineName || input.currentMachineId || null;
  return {
    // A project on a machine the relay no longer reports keeps its name and
    // reads as offline: the host going away is what the pill has to show.
    // With no project open there is no host to name, and the fleet size is
    // the answer instead -- the panel still has to be reachable from there.
    label: label ?? `${fleetSize} machines`,
    online: label ? Boolean(current) : input.machines.length > 0,
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
