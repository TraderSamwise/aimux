import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { DaemonProject } from "@/lib/api";
import type { DesktopSession } from "@/lib/desktop-state";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import { createSsrSafeJsonStorage } from "@/lib/jotai-storage";
import {
  PROJECT_LIST_LOADING,
  PROJECT_LIST_OK,
  type ProjectListStatus,
} from "@/lib/project-list-status";
import { getProjectServiceEndpoint } from "@/lib/project-connection-display";
import {
  findProjectForRef,
  projectStateKey,
  parseProjectKey,
  projectKey,
  projectRefOf,
  sameProjectRef,
  type ProjectRef,
} from "@/lib/project-key";
import { desktopStateFamily } from "@/stores/desktopState";

// ─── Base atoms ────────────────────────────────────────────────────────────

export const projectsAtom = atom<DaemonProject[]>([]);

// Persisted across reloads so the user returns to the project they last had
// open. Holds a project key, not a path: the same checkout exists on two of
// Sam's machines. An entry written before machines existed is a bare path,
// which `parseProjectKey` reads as a ref with no machine.
export const selectedProjectKeyAtom = atomWithStorage<string | null>(
  "aimux-selected-project",
  null,
  createSsrSafeJsonStorage<string | null>(),
  { getOnInit: true },
);

export const selectedProjectRefAtom = atom(
  // The storage atom's value is typed to include a pending read, which is not
  // a key; an unresolved selection is no selection yet.
  (get) => {
    const stored = get(selectedProjectKeyAtom);
    return typeof stored === "string" ? parseProjectKey(stored) : null;
  },
  (_get, set, ref: ProjectRef | null) => {
    set(selectedProjectKeyAtom, projectKey(ref));
  },
);

// Read-only: a selection is made through `selectProjectAtom` or
// `selectedProjectRefAtom`, so nothing can write a path where a key belongs.
export const selectedProjectPathAtom = atom((get) => get(selectedProjectRefAtom)?.path ?? null);

export const explicitProjectSelectionAtom = atom<{ key: string; expiresAt: number } | null>(null);

export const selectedSessionIdAtom = atom<string | null>(null);

// Why the list looks the way it does. A failed or unavailable fetch must not
// reach the UI as an empty array.
export const projectListStatusAtom = atom<ProjectListStatus>(PROJECT_LIST_LOADING);
export const lastSyncAtAtom = atom<number | null>(null);

const projectViewPathByProjectKey = new Map<string, string>();

// ─── Derived atoms ─────────────────────────────────────────────────────────

export const selectedProjectAtom = atom<DaemonProject | null>((get) => {
  const ref = get(selectedProjectRefAtom);
  if (!ref) return null;
  const projects = get(projectsAtom);
  return findProjectForRef(projects, ref) ?? null;
});

// Stable primitive-friendly endpoint atom. The underlying object changes
// identity every project-list reconcile (always a fresh array), so callers
// should depend on host/port primitives rather than this object identity.
export const selectedProjectEndpointAtom = atom<ServiceEndpoint | null>((get) => {
  const project = get(selectedProjectAtom);
  return getProjectServiceEndpoint(project);
});

export const selectedSessionAtom = atom<DesktopSession | null>((get) => {
  const project = get(selectedProjectAtom);
  const sessionId = get(selectedSessionIdAtom);
  if (!project || !sessionId) return null;
  return (
    get(desktopStateFamily(projectStateKey(projectRefOf(project))))?.sessions.find(
      (session) => session.id === sessionId,
    ) ?? null
  );
});

// ─── Action atoms ──────────────────────────────────────────────────────────

// Reconcile a fresh project snapshot from the daemon. Sorts by name. Honors
// the persisted selection if that project is still present. Otherwise falls
// back to the first sorted project and clears stale session selection.
export const reconcileProjectsAtom = atom(
  null,
  (
    get,
    set,
    incoming: DaemonProject[],
    options?: {
      unansweredMachineIds?: readonly string[];
      // The machines this snapshot is authoritative for. A selection on a
      // machine that is not in it was not contradicted by anything, so it is
      // kept -- a laptop that wakes five seconds after the app loads must not
      // cost Sam the project he had open.
      answeringMachineIds?: readonly string[];
      // Written here rather than after the call: setting "ok" and then
      // correcting it let a subscriber render a tick of "the list is whole"
      // on every poll that was in fact short.
      status?: ProjectListStatus;
    },
  ) => {
    const previousProjects = get(projectsAtom);
    // A machine that did not answer has not lost its projects; it is simply
    // absent from this snapshot. Dropping them would empty part of the list
    // every time one host blinked.
    const merged = [
      ...incoming,
      ...projectsOnMachines(previousProjects, options?.unansweredMachineIds, incoming),
    ];
    set(projectListStatusAtom, options?.status ?? PROJECT_LIST_OK);
    const sorted = reconcileProjectList(previousProjects, merged);
    let nextRef = get(selectedProjectRefAtom);
    let nextSession = get(selectedSessionIdAtom);

    if (merged.length === 0 && previousProjects.length > 0) {
      const explicitSelection = get(explicitProjectSelectionAtom);
      const preservingRecentExplicitSelection =
        explicitSelection &&
        explicitSelection.key === projectKey(nextRef) &&
        explicitSelection.expiresAt > Date.now();
      if (preservingRecentExplicitSelection) {
        set(lastSyncAtAtom, Date.now());
        return;
      }
    }

    // A selection stored before machines existed is upgraded to a full ref
    // here, so the next reload no longer depends on the fallback.
    const resolved = findProjectForRef(sorted, nextRef) ?? null;

    if (!nextRef && sorted.length > 0) {
      nextRef = projectRefOf(sorted[0]);
    } else if (nextRef && !resolved && selectionWasContradicted(nextRef, options)) {
      nextRef = projectRefOf(sorted[0]);
      nextSession = null;
    } else if (resolved) {
      nextRef = projectRefOf(resolved);
    }
    // else: the stored selection is still reachable, or nothing in this
    // snapshot had the standing to contradict it.

    if (sorted !== previousProjects) set(projectsAtom, sorted);
    if (!sameProjectRef(nextRef, get(selectedProjectRefAtom))) {
      set(selectedProjectRefAtom, nextRef);
    }
    if (nextSession !== get(selectedSessionIdAtom)) set(selectedSessionIdAtom, nextSession);
    set(lastSyncAtAtom, Date.now());
  },
);

// Whether this snapshot is entitled to move the selection off `ref`.
//
// Only the machine the selection names can say its project is gone. A ref for
// a machine that did not answer -- or has not connected yet -- is unresolved,
// not absent, and resetting it to `sorted[0]` both loses the user's place and
// starts a fight with the URL, which still names the old one.
function selectionWasContradicted(
  ref: ProjectRef,
  options?: {
    unansweredMachineIds?: readonly string[];
    answeringMachineIds?: readonly string[];
  },
): boolean {
  const answering = options?.answeringMachineIds;
  // Local mode and the first poll of a session: nothing is scoped by machine,
  // so the snapshot speaks for everything, as it always did.
  if (!answering) return true;
  if (!ref.machineId) return true;
  return answering.includes(ref.machineId);
}

// The previous snapshot's projects for machines that did not answer this time.
//
// A project with no machine belongs to nobody in particular, so it is never
// kept this way -- it would survive a genuinely empty list forever. A machine
// that appears in the incoming list did answer, whatever the caller said, so
// its stale projects are not retained alongside its fresh ones.
export function projectsOnMachines(
  projects: readonly DaemonProject[],
  machineIds: readonly string[] | undefined,
  answered: readonly DaemonProject[] = [],
): DaemonProject[] {
  if (!machineIds || machineIds.length === 0) return [];
  const answeredMachineIds = new Set(
    answered.map((project) => project.machineId).filter((id): id is string => Boolean(id)),
  );
  const wanted = new Set(machineIds.filter((id) => !answeredMachineIds.has(id)));
  if (wanted.size === 0) return [];
  return projects
    .filter((project) => project.machineId && wanted.has(project.machineId))
    .map(withUnaskableLiveness);
}

// What is kept is the project, not its liveness. The host did not answer, so
// whether a dashboard is running there is unknown -- not false, and certainly
// not the green dot and agent count it had a moment ago. Clearing
// `serviceAlive` also takes the endpoint away, so nothing tries to call a
// machine that is not there.
function withUnaskableLiveness(project: DaemonProject): DaemonProject {
  if (project.dashboardAlive === undefined && !project.serviceAlive && !project.onlineAgentCount) {
    return project;
  }
  return {
    ...project,
    dashboardAlive: undefined,
    service: null,
    serviceAlive: false,
    onlineAgentCount: undefined,
  };
}

// Select a project, clearing the session selection.
export const selectProjectAtom = atom(null, (_get, set, ref: ProjectRef | null) => {
  const key = projectKey(ref);
  if (key) set(explicitProjectSelectionAtom, { key, expiresAt: Date.now() + 1500 });
  set(selectedProjectRefAtom, ref);
  set(selectedSessionIdAtom, null);
});

// Keyed by the pair: the view you had open on strix's checkout is not the view
// you had open on the mbp's copy of it.
export function rememberProjectViewPath(ref: ProjectRef | null, viewPath: string): void {
  const key = projectKey(ref);
  if (!key || !viewPath) return;
  projectViewPathByProjectKey.set(key, viewPath);
}

export function rememberedProjectViewPath(ref: ProjectRef | null): string | null {
  const key = projectKey(ref);
  return (key && projectViewPathByProjectKey.get(key)) ?? null;
}

export function reconcileProjectList(
  previous: readonly DaemonProject[],
  incoming: readonly DaemonProject[],
): DaemonProject[] {
  const sorted = [...incoming].sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      a.path.localeCompare(b.path) ||
      a.id.localeCompare(b.id) ||
      (a.machineId ?? "").localeCompare(b.machineId ?? ""),
  );
  if (previous.length !== sorted.length) return sorted;
  for (let i = 0; i < sorted.length; i += 1) {
    if (!sameProjectSnapshot(previous[i], sorted[i])) return sorted;
  }
  return previous as DaemonProject[];
}

function sameProjectSnapshot(a: DaemonProject, b: DaemonProject): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
