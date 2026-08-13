import type { ActiveSharedSession } from "@/stores/settings";

export function resolveRouteShare({
  acceptedShares,
  legacyActiveShare,
  ownerUserId,
  pathname,
  routeProjectPath,
  sessionId,
  shareId,
  isShareRoute = pathname === "/shares" || pathname.startsWith("/shares/"),
}: {
  acceptedShares: readonly ActiveSharedSession[];
  legacyActiveShare: ActiveSharedSession | null;
  ownerUserId?: string | null;
  pathname: string;
  routeProjectPath?: string | null;
  sessionId?: string | null;
  shareId?: string | null;
  isShareRoute?: boolean;
}): ActiveSharedSession | null {
  if (isShareRoute && ownerUserId && shareId) {
    return (
      findMatchingShare(acceptedShares, { ownerUserId, shareId, sessionId }) ??
      findMatchingShare(legacyActiveShare ? [legacyActiveShare] : [], {
        ownerUserId,
        shareId,
        sessionId,
      })
    );
  }

  if (isShareRoute) return null;
  if (!isSharedLegacyCandidatePath(pathname)) return null;

  const legacyMatch = findLegacyPathShare(legacyActiveShare, sessionId, routeProjectPath);
  if (legacyMatch) return legacyMatch;

  const acceptedMatch = acceptedShares.find(
    (share) =>
      (!sessionId || share.sessionId === sessionId) &&
      (!routeProjectPath || share.projectRoot === routeProjectPath),
  );
  return acceptedMatch ?? null;
}

function findMatchingShare(
  shares: readonly ActiveSharedSession[],
  match: { ownerUserId: string; shareId: string; sessionId?: string | null },
) {
  return (
    shares.find(
      (share) =>
        share.ownerUserId === match.ownerUserId &&
        share.shareId === match.shareId &&
        (!match.sessionId || share.sessionId === match.sessionId),
    ) ?? null
  );
}

function findLegacyPathShare(
  share: ActiveSharedSession | null,
  sessionId?: string | null,
  routeProjectPath?: string | null,
) {
  if (!share) return null;
  if (sessionId && share.sessionId !== sessionId) return null;
  if (routeProjectPath && share.projectRoot !== routeProjectPath) return null;
  return sessionId || routeProjectPath ? share : null;
}

function isSharedLegacyCandidatePath(pathname: string) {
  return (
    pathname === "/" ||
    pathname.startsWith("/agent/") ||
    pathname === "/project" ||
    pathname.startsWith("/coordination") ||
    pathname.startsWith("/topology") ||
    pathname.startsWith("/library") ||
    pathname.startsWith("/notifications") ||
    pathname.startsWith("/threads") ||
    pathname.startsWith("/expose") ||
    pathname.startsWith("/loop")
  );
}
