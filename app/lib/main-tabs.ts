import { useCallback } from "react";
import { TabActions } from "@react-navigation/native";
import { useGlobalSearchParams, useRouter, type Href } from "expo-router";
import { useAtomValue } from "jotai";
import { selectedProjectRefAtom } from "@/stores/projects";
import { projectRefFromSearchOrLocation, type SearchValue } from "@/lib/view-location";

export type MainTabId =
  | "dashboard"
  | "coordination"
  | "expose"
  | "loops"
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
    | "/expose"
    | "/loops"
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
    | "expose"
    | "loops"
    | "topology"
    | "project"
    | "library"
    | "notifications"
    | "threads"
    | "(settings)";
}

type MainTabNavigation = {
  dispatch: (action: ReturnType<typeof TabActions.jumpTo>) => void;
  navigate?: (
    screen: MainTabRoute["screen"],
    params?: { project: string; machine?: string },
  ) => void;
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
  expose: {
    id: "expose",
    href: "/expose",
    internalHref: "/(main)/(tabs)/expose" as Href,
    screen: "expose",
  },
  loops: {
    id: "loops",
    href: "/loops",
    internalHref: "/(main)/(tabs)/loops" as Href,
    screen: "loops",
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

// The machine travels with the path, so moving between tabs does not lose
// which host's copy of the project is open.
export function buildMainTabHref(
  tabId: MainTabId,
  projectPath?: string | null,
  machineId?: string | null,
): Href {
  return {
    pathname: MAIN_TAB_ROUTES[tabId].internalHref,
    params: mainTabProjectParams(projectPath, machineId) ?? {},
  } as Href;
}

function mainTabProjectParams(
  projectPath?: string | null,
  machineId?: string | null,
): { project: string; machine?: string } | undefined {
  const project = typeof projectPath === "string" ? projectPath.trim() : "";
  if (!project) return undefined;
  const machine = typeof machineId === "string" ? machineId.trim() : "";
  return machine ? { project, machine } : { project };
}

export function mainTabForPath(pathname: string): MainTabId {
  if (pathname.startsWith("/coordination")) return "coordination";
  if (pathname.startsWith("/expose")) return "expose";
  if (pathname.startsWith("/loops")) return "loops";
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
  const selectedProjectRef = useAtomValue(selectedProjectRefAtom);
  const searchParams = useGlobalSearchParams() as Record<string, SearchValue>;
  // Both halves come from the same place. Taking the path from the URL and the
  // machine from the selection would pair a path with the wrong host.
  const currentRef =
    projectRefFromSearchOrLocation(searchParams.project, searchParams.machine) ??
    selectedProjectRef;

  return useCallback(
    (tabId: MainTabId) => {
      router.navigate(buildMainTabHref(tabId, currentRef?.path, currentRef?.machineId));
    },
    [currentRef, router],
  );
}

export function navigateMainTab(
  navigation: MainTabNavigation,
  tabId: MainTabId,
  projectPath?: string | null,
  machineId?: string | null,
) {
  const params = mainTabProjectParams(projectPath, machineId);
  if (navigation.navigate) {
    navigation.navigate(MAIN_TAB_ROUTES[tabId].screen, params);
    return;
  }
  navigation.dispatch(TabActions.jumpTo(MAIN_TAB_ROUTES[tabId].screen, params));
}
