import { useMemo } from "react";
import { useGlobalSearchParams, usePathname } from "expo-router";
import { useAtomValue } from "jotai";
import { useAuth } from "@/lib/auth";
import { singleRouteParam } from "@/lib/route-params";
import { resolveRouteShare } from "@/lib/route-share-resolver";
import { projectPathFromSearchOrLocation } from "@/lib/view-location";
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
    project?: string | string[];
  }>();
  const acceptedShares = useAtomValue(acceptedSharedSessionsAtom);
  const legacyActiveShare = useAtomValue(activeSharedSessionAtom);
  const { userId } = useAuth();
  const ownerUserId = singleRouteParam(params.ownerUserId);
  const shareId = singleRouteParam(params.shareId);
  const sessionId = singleRouteParam(params.sessionId);
  const routeProjectPath = projectPathFromSearchOrLocation(params.project);
  const isShareRoute = pathname === "/shares" || pathname.startsWith("/shares/");

  return useMemo(() => {
    return resolveRouteShare({
      acceptedShares,
      currentUserId: userId,
      legacyActiveShare,
      ownerUserId,
      pathname,
      routeProjectPath,
      sessionId,
      shareId,
      isShareRoute,
    });
  }, [
    acceptedShares,
    isShareRoute,
    legacyActiveShare,
    userId,
    ownerUserId,
    pathname,
    routeProjectPath,
    sessionId,
    shareId,
  ]);
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
