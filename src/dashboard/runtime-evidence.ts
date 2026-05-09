export function hasRuntimeEvidence(entry: any | undefined): boolean {
  if (!entry) return false;
  return (
    typeof entry.pid === "number" ||
    Boolean(entry.foregroundCommand) ||
    Boolean(entry.previewLine) ||
    Boolean(entry.tmuxWindowId)
  );
}

export function hasAttachableRuntimeTarget(entry: any | undefined): boolean {
  return Boolean(entry?.tmuxWindowId);
}

export function isAttachableDashboardSessionEntry(entry: any | undefined): boolean {
  return hasAttachableRuntimeTarget(entry);
}

export function isLiveDashboardServiceRuntimeEntry(entry: any | undefined): boolean {
  if (!entry) return false;
  if (entry.status === "running" && entry.pendingAction !== "starting") return true;
  return hasRuntimeEvidence(entry);
}
