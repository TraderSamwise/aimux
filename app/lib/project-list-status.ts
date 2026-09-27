// A project list has three outcomes, not one. "Succeeded with no projects",
// "could not reach the daemon" and "the request failed" are different facts, and
// rendering the last two as an empty list is how the GUI told Sam he had no
// projects while five dashboards were running.

export type ProjectListStatus =
  | { kind: "loading" }
  | { kind: "ok" }
  | { kind: "unavailable"; detail: string }
  | { kind: "failed"; detail: string };

export const PROJECT_LIST_LOADING: ProjectListStatus = { kind: "loading" };
export const PROJECT_LIST_OK: ProjectListStatus = { kind: "ok" };

export function projectListUnavailable(
  detail: string,
): Extract<ProjectListStatus, { kind: "unavailable" }> {
  return { kind: "unavailable", detail: detail.trim() || "The daemon could not be reached." };
}

export function projectListFailed(detail: string): Extract<ProjectListStatus, { kind: "failed" }> {
  return { kind: "failed", detail: detail.trim() || "The project list request failed." };
}

// What the picker shows in place of an empty list. `null` means the list is
// trustworthy and an empty one really does mean no projects.
export function projectListEmptyMessage(
  status: ProjectListStatus,
): { title: string; detail?: string } | null {
  switch (status.kind) {
    case "loading":
      return { title: "Loading projects" };
    case "unavailable":
      return { title: "Cannot reach the daemon", detail: status.detail };
    case "failed":
      return { title: "Could not load projects", detail: status.detail };
    case "ok":
      return null;
  }
}

// A list that is on screen but could not be refreshed is stale, and saying so is
// the difference between an old answer and a wrong one.
export function projectListStaleMessage(status: ProjectListStatus): string | null {
  if (status.kind === "unavailable" || status.kind === "failed") {
    return `Not refreshing: ${status.detail}`;
  }
  return null;
}

// Why the daemon is out of reach, in the user's terms. "Relay is device_pending"
// is the internal name for a state whose whole point is telling someone what to
// do about it.
export function relayUnavailableDetail(relayStatus: string): string {
  switch (relayStatus) {
    case "device_pending":
      return "This device is waiting for approval on your Mac.";
    case "daemon_offline":
      return "Your Mac is not running aimux, or it is offline.";
    case "auth_failed":
      return "This device was blocked, or its sign-in expired.";
    case "relay_unavailable":
      return "The relay is unreachable.";
    case "connecting":
    case "disconnected":
      return "Still connecting to the relay.";
    case "client_storage_error":
      return "This browser could not store its device identity.";
    default:
      return `The relay is ${relayStatus}.`;
  }
}
