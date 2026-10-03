// Which machine a daemon socket belongs to.
//
// The room is one per account, so without this dimension the second machine to
// connect evicts the first. Socket tags are the only state that survives
// hibernation, so the connect path and `rehydrateSockets` both derive machine
// identity from here rather than each keeping their own copy.

export const MACHINE_TAG_PREFIX = "machine:";
export const MACHINE_NAME_TAG_PREFIX = "machineName:";
// A daemon from before machine identity existed. It gets one slot, so such a
// daemon behaves exactly as it does today: alone in the room, replaced by the
// next connection from the same (unidentified) machine.
export const UNIDENTIFIED_MACHINE_ID = "unidentified";

export const MAX_MACHINE_ID_CHARS = 64;
export const MAX_MACHINE_NAME_CHARS = 64;

export interface MachineInfo {
  id: string;
  name: string;
}

// An id is interpolated into a socket tag and echoed to clients, so it is
// restricted to characters that cannot break either. Matches the daemon's own
// `is_valid_machine_id`.
//
// The reserved id is refused. It is a real, matchable id otherwise, so a daemon
// could ask for the slot kept for daemons that predate machine identity and
// evict one -- or be evicted by one.
export function isValidMachineId(id: string): boolean {
  return (
    id.length > 0 && id.length <= MAX_MACHINE_ID_CHARS && id !== UNIDENTIFIED_MACHINE_ID && /^[a-z0-9-]+$/.test(id)
  );
}

// A name is only ever an OS hostname. Anything else is refused rather than
// mangled, and the caller falls back to the id.
export function sanitizeMachineName(raw: string | null | undefined): string | undefined {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed || trimmed.length > MAX_MACHINE_NAME_CHARS) return undefined;
  return /^[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed : undefined;
}

export function machineFromConnectUrl(url: URL): MachineInfo {
  const rawId = url.searchParams.get("machineId")?.trim() ?? "";
  const id = isValidMachineId(rawId) ? rawId : UNIDENTIFIED_MACHINE_ID;
  const name = sanitizeMachineName(url.searchParams.get("machineName")) ?? id;
  return { id, name };
}

export function machineTag(id: string): string {
  return `${MACHINE_TAG_PREFIX}${id}`;
}

export function machineNameTag(name: string): string {
  return `${MACHINE_NAME_TAG_PREFIX}${name}`;
}

export function machineIdFromTags(tags: readonly string[]): string {
  const tagged = tags.find((tag) => tag.startsWith(MACHINE_TAG_PREFIX))?.slice(MACHINE_TAG_PREFIX.length);
  return tagged && isValidMachineId(tagged) ? tagged : UNIDENTIFIED_MACHINE_ID;
}

export function machineNameFromTags(tags: readonly string[]): string | undefined {
  return sanitizeMachineName(
    tags.find((tag) => tag.startsWith(MACHINE_NAME_TAG_PREFIX))?.slice(MACHINE_NAME_TAG_PREFIX.length),
  );
}

export function machineFromTags(tags: readonly string[]): MachineInfo {
  const id = machineIdFromTags(tags);
  return { id, name: machineNameFromTags(tags) ?? id };
}

export type DaemonTargetResolution =
  | { ok: true; machineId: string }
  | { ok: false; status: number; error: string; machines: MachineInfo[] };

// A client that names no machine is answered, not guessed at: one machine is
// unambiguous, several is a question only the client can settle. Guessing would
// route a kill to the wrong host.
export function resolveDaemonTarget(
  machines: readonly MachineInfo[],
  requestedMachineId: string | undefined,
): DaemonTargetResolution {
  const requested = requestedMachineId?.trim();
  if (machines.length === 0) {
    return { ok: false, status: 503, error: "Daemon not connected", machines: [] };
  }
  if (requested) {
    const found = machines.find((machine) => machine.id === requested);
    return found
      ? { ok: true, machineId: found.id }
      : {
          ok: false,
          status: 503,
          error: `Machine ${requested} is not connected`,
          machines: [...machines],
        };
  }
  if (machines.length === 1) {
    return { ok: true, machineId: machines[0].id };
  }
  return {
    ok: false,
    status: 409,
    error: "Several machines are connected; name one with machineId",
    machines: [...machines],
  };
}

// A room holds one daemon per machine. The cap is not a product limit, it is a
// bound: a bug that mints a new machine id per connect must not grow the map
// without end.
export const MAX_MACHINES_PER_ROOM = 16;

// A share grants one session on one host. It must not become a window onto the
// rest of the fleet, so a guest never sees the machine list and never names a
// machine: the share says which host, or there has to be only one.
export function resolveSharedDaemonTarget(
  machines: readonly MachineInfo[],
  shareMachineId: string | undefined,
): DaemonTargetResolution {
  if (machines.length === 0) {
    return { ok: false, status: 503, error: "Daemon not connected", machines: [] };
  }
  const bound = shareMachineId?.trim();
  if (bound) {
    return machines.some((machine) => machine.id === bound)
      ? { ok: true, machineId: bound }
      : {
          ok: false,
          status: 503,
          error: "The machine hosting this shared chat is not connected",
          machines: [],
        };
  }
  if (machines.length === 1) {
    return { ok: true, machineId: machines[0].id };
  }
  // Deliberately the same text as a disconnected host: the number of machines
  // on the account is not a guest's business either.
  return {
    ok: false,
    status: 503,
    error: "The machine hosting this shared chat is not connected",
    machines: [],
  };
}

// Whether the host a guest was shared from is up. `daemon_status.online` means
// "any machine", which for a guest is a fact about a fleet it cannot see and
// the wrong answer about the one host it can.
//
// Answered by asking `resolveSharedDaemonTarget`, so the indicator and the
// routing cannot disagree. They did: a guest socket's `shareMachine:` tag is
// frozen at connect and tags cannot be changed afterwards, so a share the
// owner bound to a host mid-session left the guest reading "any machine up"
// while every request it sent was refused with "the machine hosting this
// shared chat is not connected".
export function sharedHostOnline(machines: readonly MachineInfo[], shareMachineId: string | undefined): boolean {
  return resolveSharedDaemonTarget(machines, shareMachineId).ok;
}
