import { useCallback } from "react";
import { useRouter, type Href } from "expo-router";
import { useAtomValue } from "jotai";
import { selectedProjectPathAtom } from "@/stores/projects";
import { buildViewHref } from "@/lib/view-location";

export type MainTabId =
  | "dashboard"
  | "topology"
  | "project"
  | "library"
  | "inbox"
  | "threads"
  | "settings";

export interface MainTabRoute {
  id: MainTabId;
  href: "/" | "/topology" | "/project" | "/library" | "/notifications" | "/threads" | "/settings";
  internalHref: Href;
  screen:
    | "(dashboard)"
    | "topology"
    | "project"
    | "library"
    | "(inbox)"
    | "(threads)"
    | "(settings)";
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
  project: {
    id: "project",
    href: "/project",
    internalHref: "/project" as Href,
    screen: "project",
  },
  library: {
    id: "library",
    href: "/library",
    internalHref: "/library" as Href,
    screen: "library",
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
  if (pathname.startsWith("/project")) return "project";
  if (pathname.startsWith("/library")) return "library";
  if (pathname.startsWith("/notifications")) return "inbox";
  if (pathname.startsWith("/threads")) return "threads";
  if (pathname.startsWith("/settings")) return "settings";
  return "dashboard";
}

export function useMainTabNavigation() {
  const router = useRouter();
  const selectedProjectPath = useAtomValue(selectedProjectPathAtom);

  return useCallback(
    (tabId: MainTabId) => {
      router.navigate(buildViewHref(MAIN_TAB_ROUTES[tabId].href, { project: selectedProjectPath }));
    },
    [router, selectedProjectPath],
  );
}
