import { atom } from "jotai";
import { atomFamily } from "jotai/utils";
import { groupByWorktree, type DesktopState, type WorktreeBucket } from "@/lib/desktop-state";

// Keyed by project path. Holds the latest /desktop-state response for that project.
export const desktopStateFamily = atomFamily((_projectPath: string) =>
  atom<DesktopState | null>(null),
);

export const desktopStateErrorFamily = atomFamily((_projectPath: string) =>
  atom<string | null>(null),
);

// Bumped by mutations to force the polling effect to refetch immediately.
export const desktopStateRefreshNonceAtom = atom(0);
export const kickDesktopStateRefreshAtom = atom(null, (get, set) => {
  set(desktopStateRefreshNonceAtom, get(desktopStateRefreshNonceAtom) + 1);
});

// Derived: the worktree-grouped hierarchy for a project.
export const worktreeGroupsFamily = atomFamily((projectPath: string) =>
  atom<WorktreeBucket[]>((get) => {
    const state = get(desktopStateFamily(projectPath));
    if (!state) return [];
    return groupByWorktree(state);
  }),
);
