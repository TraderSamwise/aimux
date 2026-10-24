import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { DaemonProject } from "@/lib/api";
import type { DesktopSession } from "@/lib/desktop-state";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import {
  createSsrSafeJsonStorage,
  readBeforeWriteAtom,
  storageReadStateAtom,
  storedValueAtom,
} from "@/lib/jotai-storage";
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
import { rememberAgentForProject } from "@/lib/reopen-last-agent";
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

export const selectedProjectReadStateAtom = storageReadStateAtom(selectedProjectKeyAtom);

// For callers that only need to stop waiting. A read that FAILED has finished,
// so nothing waits on it forever -- but it is not a read that answered, which
// is why anything about to write the answer back consults the state itself.
export const selectedProjectHydratedAtom = atom(
  (get) => get(selectedProjectReadStateAtom) !== "unread",
);

// The stored key as storage actually answered it. Reading `selectedProjectKeyAtom`
// directly cannot work: jotai holds the pending read in the atom and never
// replaces it, so the old `typeof stored === "string"` guard read every launch
// as no selection and the remembered project was never restored.
const storedProjectKeyAtom = storedValueAtom<string | null>(selectedProjectKeyAtom, null);

/**
 * Where the app sits when the stored key could not be READ.
 *
 * In memory only, and never written back. A read that failed may be hiding a
 * selection that is still on disk, so persisting a guess over it would destroy
 * exactly what could not be read -- but an app with no project selected, on
 * every launch, is not an acceptable alternative either. Safari in private
 * mode is enough to reach this.
 */
const unreadableSelectionFallbackAtom = atom<ProjectRef | null>(null);

export const selectedProjectRefAtom = atom(
  (get) => {
    const stored = get(storedProjectKeyAtom);
    return (stored ? parseProjectKey(stored) : null) ?? get(unreadableSelectionFallbackAtom);
  },
  (_get, set, ref: ProjectRef | null) => {
    // The stored key is the answer from here on, so the in-memory stand-in
    // steps aside rather than shadowing it.
    set(unreadableSelectionFallbackAtom, null);
    set(selectedProjectKeyAtom, projectKey(ref));
  },
);

// Read-only: a selection is made through `selectProjectAtom` or
// `selectedProjectRefAtom`, so nothing can write a path where a key belongs.
export const selectedProjectPathAtom = atom((get) => get(selectedProjectRefAtom)?.path ?? null);

export const explicitProjectSelectionAtom = atom<{ key: string; expiresAt: number } | null>(null);

/**
 * Which agent the user was last reading, per project, across launches.
 *
 * The project is already remembered, so the app reopens on the right checkout
 * and then stops at a list with no way to know which agent you were in. This
 * is the last step, and it is keyed by project key rather than path because
 * the same checkout exists on two of Sam's machines.
 */
const lastAgentStorageAtom = atomWithStorage<Record<string, string>>(
  "aimux-last-agent-by-project",
  {},
  createSsrSafeJsonStorage<Record<string, string>>(),
  { getOnInit: true },
);

export const lastAgentReadStateAtom = storageReadStateAtom(lastAgentStorageAtom);

// For callers that only need to stop waiting; a read that FAILED has finished
// and has no memory to offer, which is a complete answer for reopening. The
// WRITER below needs the state itself, because it merges onto what it reads.
export const lastAgentHydratedAtom = atom((get) => get(lastAgentReadStateAtom) !== "unread");

// Module scope so the empty memory keeps one identity: callers put it in
// dependency arrays and compare it by reference. Frozen because that identity
// is shared -- one `memory[key] = id` on it would poison the empty memory for
// the whole process and then be persisted.
const NO_REMEMBERED_AGENTS: Readonly<Record<string, string>> = Object.freeze({});

// Through the shared helper for both halves of the same defect: the old
// `!("then" in stored)` guard read the pending promise as an empty memory and
// jotai never replaced it, so this read `{}` for the whole session and the
// agent you were last in was recorded on every selection and restored on
// none -- and a recording made in that window merged onto `{}` and persisted
// it, forgetting every other project's agent.
const storedLastAgentAtom = readBeforeWriteAtom<Record<string, string>>(
  lastAgentStorageAtom,
  NO_REMEMBERED_AGENTS as Record<string, string>,
);

export const lastAgentByProjectAtom = atom(
  (get) => {
    const stored = get(storedLastAgentAtom);
    // The shape half of the old guard, kept. `storedValueAtom` handles the
    // pending read, but a stored value of the wrong shape is still not a
    // memory, and the writer below merges onto whatever this returns. An array
    // is `typeof "object"` and would spread into numeric keys.
    const usable = stored && typeof stored === "object" && !Array.isArray(stored);
    return usable ? stored : NO_REMEMBERED_AGENTS;
  },
  (_get, set, memory: Record<string, string>) => {
    // `storedLastAgentAtom` holds this until the stored map has been read; see
    // `readBeforeWriteAtom` for why a recording must never land before it.
    set(storedLastAgentAtom, memory);
  },
);

const selectedSessionIdValueAtom = atom<string | null>(null);

/**
 * The agent open right now, which is transient, and the memory of it, which is
 * not.
 *
 * Twenty-nine call sites set this, so the memory is written HERE rather than
 * beside each of them -- one place a selection is recorded, and nothing to
 * forget to call. Clearing the selection does not clear the memory: the
 * clearing happens whenever the open project changes, and the next launch is
 * exactly when the memory is read.
 */
export const selectedSessionIdAtom = atom(
  (get) => get(selectedSessionIdValueAtom),
  (get, set, sessionId: string | null) => {
    set(selectedSessionIdValueAtom, sessionId);
    // The recording may be refused -- `lastAgentByProjectAtom`'s setter turns
    // it down until the stored map has been read -- and the selection itself
    // stands either way, which is why it is set first.
    const memory = rememberAgentForProject(
      get(lastAgentByProjectAtom),
      projectKey(get(selectedProjectRefAtom)),
      sessionId,
    );
    if (memory !== get(lastAgentByProjectAtom)) set(lastAgentByProjectAtom, memory);
  },
);

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

    // A selection still in flight is not a user without a selection: the
    // stored key comes back from AsyncStorage a frame or two after the first
    // project poll, and adopting `sorted[0]` in that window overwrote the
    // project Sam left -- worse than any bounce, because nothing afterwards
    // corrects it. So nothing is adopted until the read has finished, one way
    // or the other. Where the result GOES is decided once, below.
    const readState = get(selectedProjectReadStateAtom);
    if (!nextRef && readState !== "unread" && sorted.length > 0) {
      nextRef = projectRefOf(sorted[0]);
    } else if (nextRef && !resolved && selectionWasContradicted(nextRef, sorted, options)) {
      nextRef = projectRefOf(sorted[0]);
      nextSession = null;
    } else if (resolved) {
      nextRef = projectRefOf(resolved);
    }
    // else: the stored selection is still reachable, or nothing in this
    // snapshot had the standing to contradict it.

    if (sorted !== previousProjects) set(projectsAtom, sorted);
    if (!sameProjectRef(nextRef, get(selectedProjectRefAtom))) {
      // One place decides whether this is persisted, because every branch
      // above can reach it and only one of them used to be checked. A stored
      // key that could not be READ must never be written over -- it may be
      // hiding a selection that is still on disk, and a guess destroys
      // exactly what could not be read -- but the app still has to open on
      // something, so the answer is kept in memory instead.
      if (readState === "read") set(selectedProjectRefAtom, nextRef);
      else set(unreadableSelectionFallbackAtom, nextRef);
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
  projects: readonly DaemonProject[],
  options?: {
    unansweredMachineIds?: readonly string[];
    answeringMachineIds?: readonly string[];
  },
): boolean {
  const answering = options?.answeringMachineIds;
  // Local mode and the first poll of a session: nothing is scoped by machine,
  // so the snapshot speaks for everything, as it always did.
  if (!answering) return true;
  if (!ref.machineId) {
    // A selection stored before machines existed names a path and no machine.
    // If a machine still has that path the ref is ambiguous, not absent, and
    // resetting it would move the user off a project that is plainly there --
    // which is what happened on the first multi-machine poll after upgrading.
    // Only a fleet that answered and has no copy of the path contradicts it.
    return !projects.some((project) => project.path === ref.path);
  }
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
