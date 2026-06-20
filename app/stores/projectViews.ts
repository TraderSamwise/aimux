import { atom } from "jotai";
import type { ProjectApiView } from "../../src/project-api-contract";

export const projectApiViewRefreshNonceAtom = atom(0);

export const kickProjectApiViewRefreshAtom = atom(null, (get, set) => {
  set(projectApiViewRefreshNonceAtom, get(projectApiViewRefreshNonceAtom) + 1);
});

const SERVICE_VIEW_REFRESHES = new Set<ProjectApiView>([
  "coordination-worklist",
  "desktop-state",
  "graveyard",
  "library",
  "project-observability",
  "tasks",
  "threads",
  "topology",
  "worktrees",
]);

export function projectUpdateTouchesServiceView(views: readonly ProjectApiView[]): boolean {
  return views.some((view) => SERVICE_VIEW_REFRESHES.has(view));
}
