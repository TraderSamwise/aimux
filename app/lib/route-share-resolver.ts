import type { ActiveSharedSession } from "@/stores/settings";

export function resolveRouteShare({
  acceptedShares,
  legacyActiveShare,
  ownerUserId,
  pathname,
  routeProjectPath,
  sessionId,
  shareId,
  currentUserId,
  isShareRoute = pathname === "/shares" || pathname.startsWith("/shares/"),
}: {
  acceptedShares: readonly ActiveSharedSession[];
  legacyActiveShare: ActiveSharedSession | null;
  currentUserId?: string | null;
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
  if (!currentUserId) return null;

  // The session id or nothing. What the caller does with a resolved share is
  // open THAT chat, and a project root cannot name one: `ActiveSharedSession`
  // carries no machine, so a share of `/Users/sam/cs/aimux` matched the user's
  // own project of the same path -- which is what sharing between two of your
  // own accounts produces. Before that it matched on nothing at all, so a bare
  // "/" opened someone else's conversation on every launch.
  // From the path, not the param. `useGlobalSearchParams` reports the global
  // URL rather than the current route, so a `sessionId` left over from a share
  // route could still be hanging around after navigating away -- and the only
  // legacy shape that names a session is `/agent/<id>` anyway.
  const legacySessionId = legacySessionIdFromPath(pathname);
  if (!legacySessionId) return null;

  const legacyMatch = findLegacyPathShare(legacyActiveShare, legacySessionId, routeProjectPath);
  if (legacyMatch && legacyMatch.ownerUserId !== currentUserId) return legacyMatch;

  const acceptedMatch = acceptedShares.find(
    (share) =>
      share.ownerUserId !== currentUserId &&
      share.sessionId === legacySessionId &&
      (!routeProjectPath || share.projectRoot === routeProjectPath),
  );
  return acceptedMatch ?? null;
}

export function sharedChatHref(share: ActiveSharedSession) {
  return {
    pathname: "/shares/[ownerUserId]/[shareId]/agent/[sessionId]/chat",
    params: {
      ownerUserId: share.ownerUserId,
      shareId: share.shareId,
      sessionId: share.sessionId,
    },
  } as const;
}

/**
 * Where a resolved share says the app should be, or null to leave the route
 * alone.
 *
 * Extracted because the effect that does this lives in a 500-line layout that
 * no test reads, and it is the thing that actually opened someone else's chat:
 * it replaces the route for whatever resolves, with no other input. Returning
 * null on a share route is what stops it replacing its own destination.
 */
export function sharedChatRedirect(
  activeShare: ActiveSharedSession | null,
  pathname: string,
): ReturnType<typeof sharedChatHref> | null {
  if (!activeShare) return null;
  if (pathname === "/shares" || pathname.startsWith("/shares/")) return null;
  return sharedChatHref(activeShare);
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

/// `sessionId` is required rather than optional: the caller has already
/// refused a route without one, so an optional parameter here would be an
/// unreachable branch pretending to be a second line of defence.
function findLegacyPathShare(
  share: ActiveSharedSession | null,
  sessionId: string,
  routeProjectPath?: string | null,
) {
  if (!share) return null;
  if (share.sessionId !== sessionId) return null;
  if (routeProjectPath && share.projectRoot !== routeProjectPath) return null;
  return share;
}

/// The one legacy shape that names a session: `/agent/<id>` and anything under
/// it. Every other candidate path names a surface, never a conversation.
export function legacySessionIdFromPath(pathname: string): string | null {
  const match = /^\/agent\/([^/?#]+)/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : null;
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
