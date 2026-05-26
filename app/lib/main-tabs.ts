import { useCallback } from "react";
import { useRouter, type Href } from "expo-router";

export type MainTabId = "dashboard" | "topology" | "inbox" | "threads" | "settings";

export interface MainTabRoute {
  id: MainTabId;
  href: "/" | "/topology" | "/notifications" | "/threads" | "/settings";
  internalHref: Href;
  screen: "(dashboard)" | "topology" | "(inbox)" | "(threads)" | "(settings)";
}

export const MAIN_TAB_ROUTES: Record<MainTabId, MainTabRoute> = {
  dashboard: {
    id: "dashboard",
    href: "/",
    internalHref: "/(main)/(tabs)/(dashboard)",
    screen: "(dashboard)",
  },
  topology: {
    id: "topology",
    href: "/topology",
    internalHref: "/(main)/(tabs)/topology",
    screen: "topology",
  },
  inbox: {
    id: "inbox",
    href: "/notifications",
    internalHref: "/(main)/(tabs)/(inbox)/notifications",
    screen: "(inbox)",
  },
  threads: {
    id: "threads",
    href: "/threads",
    internalHref: "/(main)/(tabs)/(threads)/threads",
    screen: "(threads)",
  },
  settings: {
    id: "settings",
    href: "/settings",
    internalHref: "/(main)/(tabs)/(settings)/settings",
    screen: "(settings)",
  },
};

export function mainTabForPath(pathname: string): MainTabId {
  if (pathname.startsWith("/topology")) return "topology";
  if (pathname.startsWith("/notifications")) return "inbox";
  if (pathname.startsWith("/threads")) return "threads";
  if (pathname.startsWith("/settings")) return "settings";
  return "dashboard";
}

export function useMainTabNavigation() {
  const router = useRouter();

  return useCallback(
    (tabId: MainTabId) => {
      router.navigate(MAIN_TAB_ROUTES[tabId].internalHref);
    },
    [router],
  );
}
