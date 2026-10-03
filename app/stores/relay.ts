import { atom } from "jotai";
import type { RelayMachine, RelayStatus } from "@/lib/relay-transport";

// Mirrors the live RelayTransport status so UI can show a connection indicator.
// Set by the relay lifecycle effect in (main)/_layout.tsx.
export const relayStatusAtom = atom<RelayStatus>("disconnected");

export const relayPendingApprovalAtom = atom<{ deviceId?: string; approvalCode?: string } | null>(
  null,
);

// True when the app is running in relay mode, either by production default or
// EXPO_PUBLIC_AIMUX_CONNECTION_MODE=relay.
export const relayConfiguredAtom = atom<boolean>(false);

// The account's machines, as the relay last reported them. Empty means either
// local mode, a shared-guest surface, or no machine connected -- the project
// list's own status says which.
export const relayMachinesAtom = atom<RelayMachine[]>([]);

// Every machine seen since this app loaded, connected or not.
//
// The project fan-out only asks machines the relay currently reports, so a
// machine that goes away is never queried and would simply vanish from the
// list. Remembering it is what lets the list keep its last-known projects and
// say the host is away -- going away is information, not absence.
export const knownMachinesAtom = atom<RelayMachine[]>([]);

export const recordRelayMachinesAtom = atom(null, (get, set, machines: RelayMachine[]) => {
  set(relayMachinesAtom, machines);
  const merged = mergeKnownMachines(get(knownMachinesAtom), machines);
  if (merged !== get(knownMachinesAtom)) set(knownMachinesAtom, merged);
});

// Machines we have seen that the relay is no longer reporting.
export const departedMachineIdsAtom = atom((get) => {
  const connected = new Set(get(relayMachinesAtom).map((machine) => machine.id));
  return get(knownMachinesAtom)
    .filter((machine) => !connected.has(machine.id))
    .map((machine) => machine.id);
});

// Keeps every machine already known and takes the newest name for each, so a
// renamed host does not become a second entry. Returns the same array when
// nothing changed, so an atom write can be skipped.
export function mergeKnownMachines(
  known: readonly RelayMachine[],
  connected: readonly RelayMachine[],
): RelayMachine[] {
  let changed = false;
  const merged = known.map((machine) => {
    const current = connected.find((candidate) => candidate.id === machine.id);
    if (!current || current.name === machine.name) return machine;
    changed = true;
    return current;
  });
  for (const machine of connected) {
    if (merged.some((candidate) => candidate.id === machine.id)) continue;
    merged.push(machine);
    changed = true;
  }
  return changed ? merged : (known as RelayMachine[]);
}
