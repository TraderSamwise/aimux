import { atom } from "jotai";
import type { ProjectApiView } from "../../src/project-api-contract";

type AppProjectApiViewRefresh = {
  projectApiViews: boolean;
  desktopState: boolean;
  notificationFeed: boolean;
};

export const APP_PROJECT_API_VIEW_REGISTRY = {
  agents: { projectApiViews: true, desktopState: true, notificationFeed: false },
  "coordination-worklist": { projectApiViews: true, desktopState: false, notificationFeed: false },
  "desktop-state": { projectApiViews: true, desktopState: true, notificationFeed: false },
  graveyard: { projectApiViews: true, desktopState: false, notificationFeed: false },
  library: { projectApiViews: true, desktopState: false, notificationFeed: false },
  notifications: { projectApiViews: true, desktopState: false, notificationFeed: true },
  "project-observability": { projectApiViews: true, desktopState: false, notificationFeed: false },
  services: { projectApiViews: true, desktopState: true, notificationFeed: false },
  tasks: { projectApiViews: true, desktopState: false, notificationFeed: false },
  threads: { projectApiViews: true, desktopState: false, notificationFeed: false },
  topology: { projectApiViews: true, desktopState: false, notificationFeed: false },
  worktrees: { projectApiViews: true, desktopState: true, notificationFeed: false },
} satisfies Record<ProjectApiView, AppProjectApiViewRefresh>;

export const projectApiViewRefreshNonceAtom = atom(0);

export const kickProjectApiViewRefreshAtom = atom(null, (get, set) => {
  set(projectApiViewRefreshNonceAtom, get(projectApiViewRefreshNonceAtom) + 1);
});

function projectUpdateTouches(
  views: readonly string[],
  key: keyof AppProjectApiViewRefresh,
): boolean {
  return views.some((view) => {
    const refresh = APP_PROJECT_API_VIEW_REGISTRY[view as ProjectApiView];
    if (!refresh) return key === "projectApiViews";
    return refresh[key];
  });
}

export function projectUpdateTouchesProjectApiView(views: readonly string[]): boolean {
  return projectUpdateTouches(views, "projectApiViews");
}

export function projectUpdateTouchesDesktopState(views: readonly string[]): boolean {
  return projectUpdateTouches(views, "desktopState");
}

export function projectUpdateTouchesNotificationFeed(views: readonly string[]): boolean {
  return projectUpdateTouches(views, "notificationFeed");
}
