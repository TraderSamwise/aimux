import { atom } from "jotai";
import { atomFamily } from "jotai/utils";
import { PROJECT_API_VIEWS, type ProjectApiView } from "../../src/project-api-contract";

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
  plans: { projectApiViews: true, desktopState: false, notificationFeed: false },
  "project-observability": { projectApiViews: true, desktopState: false, notificationFeed: false },
  services: { projectApiViews: true, desktopState: true, notificationFeed: false },
  team: { projectApiViews: true, desktopState: false, notificationFeed: false },
  tasks: { projectApiViews: true, desktopState: false, notificationFeed: false },
  threads: { projectApiViews: true, desktopState: false, notificationFeed: false },
  topology: { projectApiViews: true, desktopState: false, notificationFeed: false },
  worktrees: { projectApiViews: true, desktopState: true, notificationFeed: false },
} satisfies Record<ProjectApiView, AppProjectApiViewRefresh>;

export const projectApiViewRefreshNonceFamily = atomFamily((_view: ProjectApiView) => atom(0));

export const kickProjectApiViewRefreshAtom = atom(null, (get, set, views?: readonly string[]) => {
  for (const view of projectApiViewsForRefresh(views)) {
    const nonceAtom = projectApiViewRefreshNonceFamily(view);
    set(nonceAtom, get(nonceAtom) + 1);
  }
});

const APP_PROJECT_API_VIEW_DEPENDENCIES = {
  agents: [
    "agents",
    "coordination-worklist",
    "graveyard",
    "project-observability",
    "team",
    "topology",
    "worktrees",
  ],
  "coordination-worklist": ["coordination-worklist", "project-observability"],
  "desktop-state": [
    "agents",
    "desktop-state",
    "graveyard",
    "project-observability",
    "services",
    "team",
    "topology",
    "worktrees",
  ],
  graveyard: ["graveyard", "project-observability"],
  library: ["library"],
  notifications: ["coordination-worklist", "notifications", "project-observability"],
  plans: ["plans"],
  "project-observability": ["project-observability"],
  services: ["project-observability", "services", "topology"],
  team: ["agents", "coordination-worklist", "project-observability", "tasks", "team", "threads"],
  tasks: ["coordination-worklist", "project-observability", "tasks", "threads"],
  threads: ["coordination-worklist", "project-observability", "threads"],
  topology: ["project-observability", "topology"],
  worktrees: ["agents", "graveyard", "library", "project-observability", "topology", "worktrees"],
} satisfies Record<ProjectApiView, readonly ProjectApiView[]>;

export function projectApiViewsForRefresh(views?: readonly string[]): ProjectApiView[] {
  if (!views) return [...PROJECT_API_VIEWS];
  const result = new Set<ProjectApiView>();
  for (const view of views) {
    if (isProjectApiView(view)) {
      for (const dependentView of APP_PROJECT_API_VIEW_DEPENDENCIES[view]) {
        result.add(dependentView);
      }
    } else {
      return [...PROJECT_API_VIEWS];
    }
  }
  return [...result];
}

function isProjectApiView(view: string): view is ProjectApiView {
  return (PROJECT_API_VIEWS as readonly string[]).includes(view);
}

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
