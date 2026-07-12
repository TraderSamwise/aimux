import { useCallback } from "react";
import { TabActions } from "@react-navigation/native";
import { useGlobalSearchParams, useNavigation, type Href } from "expo-router";
import { useAtomValue } from "jotai";
import { selectedProjectPathAtom } from "@/stores/projects";
import { projectPathFromSearchOrLocation, type SearchValue } from "@/lib/view-location";

export type MainTabId =
  | "dashboard"
  | "coordination"
  | "topology"
  | "project"
  | "library"
  | "inbox"
  | "threads"
  | "settings";

export interface MainTabRoute {
  id: MainTabId;
  href:
    | "/"
    | "/coordination"
    | "/topology"
    | "/project"
    | "/library"
    | "/notifications"
    | "/threads"
    | "/settings";
  internalHref: Href;
  screen:
    | "(dashboard)"
    | "coordination"
    | "topology"
    | "project"
    | "library"
    | "notifications"
    | "threads"
    | "(settings)";
}

type MainTabNavigation = {
  dispatch: (action: ReturnType<typeof TabActions.jumpTo>) => void;
  navigate?: (screen: MainTabRoute["screen"], params?: { project: string }) => void;
};

export const MAIN_TAB_ROUTES: Record<MainTabId, MainTabRoute> = {
  dashboard: {
    id: "dashboard",
    href: "/",
    internalHref: "/(main)/(tabs)/(dashboard)",
    screen: "(dashboard)",
  },
  coordination: {
    id: "coordination",
    href: "/coordination",
    internalHref: "/(main)/(tabs)/coordination" as Href,
    screen: "coordination",
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
    internalHref: "/(main)/(tabs)/project" as Href,
    screen: "project",
  },
  library: {
    id: "library",
    href: "/library",
    internalHref: "/(main)/(tabs)/library" as Href,
    screen: "library",
  },
  inbox: {
    id: "inbox",
    href: "/notifications",
    internalHref: "/(main)/(tabs)/notifications",
    screen: "notifications",
  },
  threads: {
    id: "threads",
    href: "/threads",
    internalHref: "/(main)/(tabs)/threads",
    screen: "threads",
  },
  settings: {
    id: "settings",
    href: "/settings",
    internalHref: "/(main)/(tabs)/(settings)/settings",
    screen: "(settings)",
  },
};

export function buildMainTabHref(tabId: MainTabId, projectPath?: string | null): Href {
  const params =
    typeof projectPath === "string" && projectPath.trim().length > 0
      ? { project: projectPath }
      : {};
  return { pathname: MAIN_TAB_ROUTES[tabId].internalHref, params } as Href;
}

export function mainTabForPath(pathname: string): MainTabId {
  if (pathname.startsWith("/coordination")) return "coordination";
  if (pathname.startsWith("/topology")) return "topology";
  if (pathname.startsWith("/project")) return "project";
  if (pathname.startsWith("/library")) return "library";
  if (pathname.startsWith("/notifications")) return "inbox";
  if (pathname.startsWith("/threads")) return "threads";
  if (pathname.startsWith("/settings")) return "settings";
  return "dashboard";
}

export function useMainTabNavigation() {
  const navigation = useNavigation() as MainTabNavigation;
  const selectedProjectPath = useAtomValue(selectedProjectPathAtom);
  const searchParams = useGlobalSearchParams() as Record<string, SearchValue>;
  const currentProjectPath =
    projectPathFromSearchOrLocation(searchParams.project) ?? selectedProjectPath;

  return useCallback(
    (tabId: MainTabId) => {
      navigateMainTab(navigation, tabId, currentProjectPath);
    },
    [currentProjectPath, navigation],
  );
}

export function navigateMainTab(
  navigation: MainTabNavigation,
  tabId: MainTabId,
  projectPath?: string | null,
) {
  const params =
    typeof projectPath === "string" && projectPath.trim().length > 0
      ? { project: projectPath }
      : undefined;
  if (navigation.navigate) {
    navigation.navigate(MAIN_TAB_ROUTES[tabId].screen, params);
    return;
  }
  navigation.dispatch(TabActions.jumpTo(MAIN_TAB_ROUTES[tabId].screen, params));
}
