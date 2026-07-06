import { atom } from "jotai";
import { atomFamily } from "jotai/utils";
import { groupByWorktree, type DesktopState, type WorktreeBucket } from "@/lib/desktop-state";

export interface DesktopStateResource {
  value: DesktopState | null;
  error: string | null;
  pending: boolean;
  stale: boolean;
  updatedAt: number | null;
}

export interface ApplyDesktopStateSuccessInput {
  projectPath: string;
  state: DesktopState;
  updatedAt?: number;
}

export interface ApplyDesktopStateFailureInput {
  projectPath: string;
  error: string;
}

const emptyDesktopStateResource = (): DesktopStateResource => ({
  value: null,
  error: null,
  pending: false,
  stale: false,
  updatedAt: null,
});

// Keyed by project path. Holds the critical /desktop-state resource lifecycle.
export const desktopStateResourceFamily = atomFamily((_projectPath: string) =>
  atom<DesktopStateResource>(emptyDesktopStateResource()),
);

export const desktopStateFamily = atomFamily((projectPath: string) =>
  atom(
    (get) => get(desktopStateResourceFamily(projectPath)).value,
    (get, set, value: DesktopState | null) => {
      const current = get(desktopStateResourceFamily(projectPath));
      set(desktopStateResourceFamily(projectPath), {
        ...current,
        value,
        error: value ? null : current.error,
        pending: false,
        stale: false,
        updatedAt: value ? Date.now() : current.updatedAt,
      });
    },
  ),
);

export const desktopStateErrorFamily = atomFamily((projectPath: string) =>
  atom(
    (get) => get(desktopStateResourceFamily(projectPath)).error,
    (get, set, error: string | null) => {
      const current = get(desktopStateResourceFamily(projectPath));
      set(desktopStateResourceFamily(projectPath), {
        ...current,
        error,
      });
    },
  ),
);

// Bumped by mutations to force the polling effect to refetch immediately.
export const desktopStateRefreshNonceAtom = atom(0);
export const kickDesktopStateRefreshAtom = atom(null, (get, set) => {
  set(desktopStateRefreshNonceAtom, get(desktopStateRefreshNonceAtom) + 1);
});

export const beginDesktopStateRefreshAtom = atom(null, (get, set, projectPath: string) => {
  const current = get(desktopStateResourceFamily(projectPath));
  set(desktopStateResourceFamily(projectPath), {
    ...current,
    pending: true,
    stale: current.value !== null,
  });
});

export const applyDesktopStateSuccessAtom = atom(
  null,
  (_get, set, { projectPath, state, updatedAt }: ApplyDesktopStateSuccessInput) => {
    set(desktopStateResourceFamily(projectPath), {
      value: state,
      error: null,
      pending: false,
      stale: false,
      updatedAt: updatedAt ?? Date.now(),
    });
  },
);

export const applyDesktopStateFailureAtom = atom(
  null,
  (get, set, { projectPath, error }: ApplyDesktopStateFailureInput) => {
    const current = get(desktopStateResourceFamily(projectPath));
    set(desktopStateResourceFamily(projectPath), {
      ...current,
      error,
      pending: false,
      stale: current.value !== null,
    });
  },
);

export const clearDesktopStateResourceAtom = atom(null, (_get, set, projectPath: string) => {
  set(desktopStateResourceFamily(projectPath), emptyDesktopStateResource());
});

// Derived: the worktree-grouped hierarchy for a project.
export const worktreeGroupsFamily = atomFamily((projectPath: string) =>
  atom<WorktreeBucket[]>((get) => {
    const state = get(desktopStateFamily(projectPath));
    if (!state) return [];
    return groupByWorktree(state);
  }),
);
