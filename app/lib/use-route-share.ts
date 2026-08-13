import { useMemo } from "react";
import { useGlobalSearchParams, usePathname } from "expo-router";
import { useAtomValue } from "jotai";
import { singleRouteParam } from "@/lib/route-params";
import {
  acceptedSharedSessionsAtom,
  activeSharedSessionAtom,
  type ActiveSharedSession,
} from "@/stores/settings";

export function useRouteShare(): ActiveSharedSession | null {
  const pathname = usePathname();
  const params = useGlobalSearchParams<{
    ownerUserId?: string | string[];
    shareId?: string | string[];
    sessionId?: string | string[];
  }>();
  const acceptedShares = useAtomValue(acceptedSharedSessionsAtom);
  const legacyActiveShare = useAtomValue(activeSharedSessionAtom);
  const ownerUserId = singleRouteParam(params.ownerUserId);
  const shareId = singleRouteParam(params.shareId);
  const sessionId = singleRouteParam(params.sessionId);
  const isShareRoute = pathname === "/shares" || pathname.startsWith("/shares/");

  return useMemo(() => {
    if (!isShareRoute || !ownerUserId || !shareId) return null;
    const routeShare =
      acceptedShares.find(
        (share) =>
          share.ownerUserId === ownerUserId &&
          share.shareId === shareId &&
          (!sessionId || share.sessionId === sessionId),
      ) ??
      (legacyActiveShare?.ownerUserId === ownerUserId &&
      legacyActiveShare.shareId === shareId &&
      (!sessionId || legacyActiveShare.sessionId === sessionId)
        ? legacyActiveShare
        : null);
    return routeShare ?? null;
  }, [acceptedShares, isShareRoute, legacyActiveShare, ownerUserId, sessionId, shareId]);
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
