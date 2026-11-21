import type { FleetUsageResponse } from "@/lib/api";

/**
 * One machine the app could send a per-machine mutation to.
 *
 * `reachable` is separate from being LISTED on purpose. A machine that did not
 * answer the fleet read still belongs on screen — the fleet report's own rule
 * is that every machine stays in it — but offering a control that the relay is
 * going to refuse is worse than not offering one, so it is listed and not
 * selectable, with the reason it gave.
 */
export type MachineTarget = {
  machineId: string;
  reachable: boolean;
  reason?: string;
};

/**
 * Which machines a per-machine control may address.
 *
 * `unknown` is NOT an empty fleet. A report with no `machines` key means this
 * machine could not find out which machines exist; an empty array means the
 * relay said there are none. Collapsing them would show "one machine" to
 * somebody whose whole fleet is unreachable.
 */
export type MachineTargets =
  | { kind: "loading" }
  | { kind: "unknown"; reason: string }
  | { kind: "known"; targets: MachineTarget[] };

export function machineTargets(report: FleetUsageResponse | null): MachineTargets {
  if (report == null) return { kind: "loading" };

  const machines = report.machines;
  if (machines == null) {
    return {
      kind: "unknown",
      // The report's own reason when it gave one, never a guess.
      reason: report.error ?? "This machine could not find out which machines exist.",
    };
  }

  return {
    kind: "known",
    targets: machines.map((machine) => ({
      machineId: machine.machineId,
      // `=== true` rather than truthy: an absent `ok` means the machine never
      // reported, which is not the same as reporting success, and a missing
      // field must not read as reachable.
      reachable: machine.ok === true,
      ...(machine.ok === true
        ? {}
        : {
            reason:
              machine.error ??
              (machine.status == null ? "no answer" : `answered ${machine.status}`),
          }),
    })),
  };
}

/**
 * The machines a control may actually act on.
 *
 * Filtering a shared list is allowed; computing a different one is not — so
 * this narrows `machineTargets` rather than re-deriving reachability.
 */
export function selectableMachines(targets: MachineTargets): MachineTarget[] {
  return targets.kind === "known" ? targets.targets.filter((target) => target.reachable) : [];
}
