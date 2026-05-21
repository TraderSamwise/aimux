export type PendingDashboardActionKind =
  | PendingSessionActionKind
  | PendingServiceActionKind
  | PendingWorktreeActionKind;

export type PendingSessionActionKind =
  | "creating"
  | "forking"
  | "migrating"
  | "starting"
  | "stopping"
  | "graveyarding"
  | "renaming";

export type PendingServiceActionKind = "creating" | "starting" | "stopping" | "removing";

export type PendingWorktreeActionKind = "creating" | "removing" | "graveyarding";

const BLOCKING_PENDING_DASHBOARD_ACTIONS = new Set<string>([
  "creating",
  "forking",
  "migrating",
  "starting",
  "stopping",
  "graveyarding",
  "renaming",
  "removing",
]);

export function isBlockingPendingDashboardActionKind(
  kind: string | null | undefined,
): kind is PendingDashboardActionKind {
  return Boolean(kind && BLOCKING_PENDING_DASHBOARD_ACTIONS.has(kind));
}
