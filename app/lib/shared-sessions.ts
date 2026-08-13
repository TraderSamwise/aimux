import type { SharedSessionSummary } from "@/lib/api";
import type { ActiveSharedSession } from "@/stores/settings";

export function activeSessionsFromShareSummaries(
  shares: readonly SharedSessionSummary[],
): ActiveSharedSession[] {
  return shares
    .filter((share) => share.serviceEndpoint)
    .map((share) => ({
      shareId: share.id,
      ownerUserId: share.ownerUserId,
      projectRoot: share.projectRoot,
      sessionId: share.sessionId,
      serviceEndpoint: share.serviceEndpoint!,
      acceptedAt: share.updatedAt || share.createdAt,
    }));
}

export function sharedSessionsEqual(
  a: readonly ActiveSharedSession[],
  b: readonly ActiveSharedSession[],
): boolean {
  if (a.length !== b.length) return false;
  for (let idx = 0; idx < a.length; idx += 1) {
    const left = a[idx]!;
    const right = b[idx]!;
    if (
      left.shareId !== right.shareId ||
      left.ownerUserId !== right.ownerUserId ||
      left.projectRoot !== right.projectRoot ||
      left.sessionId !== right.sessionId ||
      left.acceptedAt !== right.acceptedAt ||
      left.serviceEndpoint.host !== right.serviceEndpoint.host ||
      left.serviceEndpoint.port !== right.serviceEndpoint.port
    ) {
      return false;
    }
  }
  return true;
}

export function mergeActiveSharedSessions(
  shares: readonly ActiveSharedSession[],
  activeShare: ActiveSharedSession | null | undefined,
): ActiveSharedSession[] {
  if (!activeShare) return [...shares];
  const byKey = new Map<string, ActiveSharedSession>();
  for (const share of shares) byKey.set(sharedSessionKey(share), share);
  byKey.set(sharedSessionKey(activeShare), activeShare);
  return [...byKey.values()].sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt));
}

export function shouldApplySharedSessionHydrate(
  current: readonly ActiveSharedSession[],
  next: readonly ActiveSharedSession[],
  opts?: { preserveEmptyOnce?: boolean },
): boolean {
  return !(opts?.preserveEmptyOnce && next.length === 0 && current.length > 0);
}

function sharedSessionKey(share: ActiveSharedSession) {
  return `${share.ownerUserId}:${share.shareId}`;
}
