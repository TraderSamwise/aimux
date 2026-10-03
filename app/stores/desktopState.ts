import { atom } from "jotai";
import type { ProjectStateKey } from "@/lib/project-key";
import { atomFamily } from "jotai/utils";
import { groupByWorktree, type DesktopState, type WorktreeBucket } from "@/lib/desktop-state";
import { reuseUnchangedEntries } from "@/lib/structural-reuse";
import {
  applyProjectLifecycleTransitionsToDesktopState,
  clearProjectLifecycleTransitionsAtom,
  projectLifecycleTransitionsFamily,
  settleProjectLifecycleTransitionsAtom,
} from "@/stores/lifecycleTransitions";

export interface DesktopStateResource {
  value: DesktopState | null;
  error: string | null;
  pending: boolean;
  stale: boolean;
  updatedAt: number | null;
}

export interface ApplyDesktopStateSuccessInput {
  projectStateKey: ProjectStateKey;
  state: DesktopState;
  updatedAt?: number;
}

export interface ApplyDesktopStateFailureInput {
  projectStateKey: ProjectStateKey;
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
export const desktopStateResourceFamily = atomFamily((_projectStateKey: ProjectStateKey) =>
  atom<DesktopStateResource>(emptyDesktopStateResource()),
);

export const desktopStateFamily = atomFamily((projectStateKey: ProjectStateKey) =>
  atom(
    (get) =>
      applyProjectLifecycleTransitionsToDesktopState(
        get(desktopStateResourceFamily(projectStateKey)).value,
        get(projectLifecycleTransitionsFamily(projectStateKey)),
      ),
    (get, set, value: DesktopState | null) => {
      const current = get(desktopStateResourceFamily(projectStateKey));
      set(desktopStateResourceFamily(projectStateKey), {
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

export const desktopStateErrorFamily = atomFamily((projectStateKey: ProjectStateKey) =>
  atom(
    (get) => get(desktopStateResourceFamily(projectStateKey)).error,
    (get, set, error: string | null) => {
      const current = get(desktopStateResourceFamily(projectStateKey));
      set(desktopStateResourceFamily(projectStateKey), {
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

export const beginDesktopStateRefreshAtom = atom(
  null,
  (get, set, projectStateKey: ProjectStateKey) => {
    const current = get(desktopStateResourceFamily(projectStateKey));
    set(desktopStateResourceFamily(projectStateKey), {
      ...current,
      error: null,
      pending: true,
      stale: current.value !== null,
    });
  },
);

// A poll that returns the same state is not new data. Storing a fresh object
// anyway rebuilds every worktree bucket and session below it, so no row can
// memoize and all of them re-render -- measured at ~120ms for 35 agents, three
// times a poll cycle. Comparing first costs ~0.6ms.
function sameDesktopState(a: DesktopState | null, b: DesktopState): boolean {
  if (!a) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

// When something did change, only the parts that actually changed should get new
// identities. The daemon rebuilds the whole payload every poll, so without this
// a single unrelated field -- `loopAlertState`, which nothing in the app renders
// -- gave every collection a new identity and re-rendered all 35 agent rows.
function mergeDesktopState(previous: DesktopState | null, next: DesktopState): DesktopState {
  if (!previous) return next;
  const merged: Record<string, unknown> = { ...next };

  // Entry-level reuse for the collections the dashboard renders, so one agent
  // changing re-renders one row rather than the list.
  merged.sessions = reuseUnchangedEntries(previous.sessions, next.sessions, (s) => s.id);
  merged.services = reuseUnchangedEntries(previous.services, next.services, (s) => s.id);
  merged.worktrees = reuseUnchangedEntries(
    previous.worktrees,
    next.worktrees,
    (w) => w.path ?? w.name ?? "",
  );
  if (previous.worktreeGroups && next.worktreeGroups) {
    merged.worktreeGroups = reuseUnchangedEntries(
      previous.worktreeGroups,
      next.worktreeGroups,
      (g) => g.path ?? g.name ?? "",
    );
  }

  // Field-level reuse for everything else. A field that did not change keeps its
  // identity, so a consumer that reads only that field does not re-render.
  const prior = previous as unknown as Record<string, unknown>;
  for (const key of Object.keys(merged)) {
    const before = prior[key];
    const after = merged[key];
    if (before === after || before === undefined) continue;
    if (typeof after !== "object" || after === null) continue;
    if (JSON.stringify(before) === JSON.stringify(after)) merged[key] = before;
  }

  return merged as unknown as DesktopState;
}

export const applyDesktopStateSuccessAtom = atom(
  null,
  (get, set, { projectStateKey, state, updatedAt }: ApplyDesktopStateSuccessInput) => {
    const current = get(desktopStateResourceFamily(projectStateKey));
    // Keep the previous object when nothing changed. updatedAt still advances,
    // so "when did we last hear from the host" stays honest.
    const value = sameDesktopState(current.value, state)
      ? current.value!
      : mergeDesktopState(current.value, state);
    set(desktopStateResourceFamily(projectStateKey), {
      value,
      error: null,
      pending: false,
      stale: false,
      updatedAt: updatedAt ?? Date.now(),
    });
    set(settleProjectLifecycleTransitionsAtom, { projectStateKey, state });
  },
);

export const applyDesktopStateFailureAtom = atom(
  null,
  (get, set, { projectStateKey, error }: ApplyDesktopStateFailureInput) => {
    const current = get(desktopStateResourceFamily(projectStateKey));
    set(desktopStateResourceFamily(projectStateKey), {
      ...current,
      error,
      pending: false,
      stale: current.value !== null,
    });
  },
);

export const clearDesktopStateResourceAtom = atom(
  null,
  (_get, set, projectStateKey: ProjectStateKey) => {
    set(desktopStateResourceFamily(projectStateKey), emptyDesktopStateResource());
    set(clearProjectLifecycleTransitionsAtom, projectStateKey);
  },
);

// Derived: the worktree-grouped hierarchy for a project.
// groupByWorktree reads only these fields. Deriving the buckets from the whole
// desktop state meant any other field invalidated all of them -- and the daemon
// ships `loopAlertState`, which nothing in the app renders and which changes on
// nearly every poll. That alone rebuilt every bucket and re-rendered all 35 rows
// three times a minute for output nobody could see.
type GroupingInput = Pick<
  DesktopState,
  | "sessions"
  | "services"
  | "worktrees"
  | "worktreeGroups"
  | "supervisorLane"
  | "mainCheckoutPath"
  | "mainCheckoutInfo"
>;

const GROUPING_FIELDS: Array<keyof GroupingInput> = [
  "sessions",
  "services",
  "worktrees",
  "worktreeGroups",
  "supervisorLane",
  "mainCheckoutPath",
  "mainCheckoutInfo",
];

function groupingInput(state: DesktopState): GroupingInput {
  return {
    sessions: state.sessions,
    services: state.services,
    worktrees: state.worktrees,
    worktreeGroups: state.worktreeGroups,
    supervisorLane: state.supervisorLane,
    mainCheckoutPath: state.mainCheckoutPath,
    mainCheckoutInfo: state.mainCheckoutInfo,
  };
}

function sameGroupingInput(a: GroupingInput, b: GroupingInput): boolean {
  // Reference equality is enough because applyDesktopStateSuccessAtom reuses the
  // previous entries for anything that did not change.
  return GROUPING_FIELDS.every((field) => a[field] === b[field]);
}

export const worktreeGroupsFamily = atomFamily((projectStateKey: ProjectStateKey) => {
  let lastInput: GroupingInput | null = null;
  let lastGroups: WorktreeBucket[] = [];
  return atom<WorktreeBucket[]>((get) => {
    const state = get(desktopStateFamily(projectStateKey));
    if (!state) {
      lastInput = null;
      lastGroups = [];
      return lastGroups;
    }
    const input = groupingInput(state);
    if (lastInput && sameGroupingInput(lastInput, input)) return lastGroups;
    lastInput = input;
    lastGroups = groupByWorktree(state);
    return lastGroups;
  });
});

// The dashboard needs these two facts but must not subscribe to the whole state
// object to get them.
export const desktopStatePresentFamily = atomFamily((projectStateKey: ProjectStateKey) =>
  atom((get) => get(desktopStateFamily(projectStateKey)) !== null),
);

export const desktopStateOperationFailuresFamily = atomFamily((projectStateKey: ProjectStateKey) =>
  atom((get) => get(desktopStateFamily(projectStateKey))?.operationFailures),
);
