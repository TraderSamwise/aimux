import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { DaemonProject, ProjectSession } from "@/lib/api";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import { createSsrSafeJsonStorage } from "@/lib/jotai-storage";

// ─── Base atoms ────────────────────────────────────────────────────────────

export const projectsAtom = atom<DaemonProject[]>([]);

// Persisted across reloads so the user returns to the project they last had open.
export const selectedProjectPathAtom = atomWithStorage<string | null>(
  "aimux-selected-project",
  null,
  createSsrSafeJsonStorage<string | null>(),
  { getOnInit: true },
);

export const selectedSessionIdAtom = atom<string | null>(null);
export const lastSyncAtAtom = atom<number | null>(null);

// ─── Derived atoms ─────────────────────────────────────────────────────────

export const selectedProjectAtom = atom<DaemonProject | null>((get) => {
  const path = get(selectedProjectPathAtom);
  if (!path) return null;
  return get(projectsAtom).find((p) => p.path === path) ?? null;
});

// Stable primitive-friendly endpoint atom. The underlying object changes
// identity every project-list reconcile (always a fresh array), so callers
// should depend on host/port primitives rather than this object identity.
export const selectedProjectEndpointAtom = atom<ServiceEndpoint | null>((get) => {
  const project = get(selectedProjectAtom);
  return project?.serviceEndpoint ?? null;
});

export const selectedSessionAtom = atom<ProjectSession | null>((get) => {
  const project = get(selectedProjectAtom);
  const sessionId = get(selectedSessionIdAtom);
  if (!project || !sessionId) return null;
  return project.sessions.find((s) => s.id === sessionId) ?? null;
});

// ─── Action atoms ──────────────────────────────────────────────────────────

// Reconcile a fresh project snapshot from the daemon. Sorts by name. Honors a
// persisted selectedProjectPath if it's still present in the incoming list.
// Otherwise falls back to the first sorted project and clears stale session
// selection. Mirrors desktop-ui/src/stores/state.svelte.js:1353-1411 behavior
// with the new persisted-path safeguard.
export const reconcileProjectsAtom = atom(null, (get, set, incoming: DaemonProject[]) => {
  const sorted = [...incoming].sort((a, b) => a.name.localeCompare(b.name));
  let nextPath = get(selectedProjectPathAtom);
  let nextSession = get(selectedSessionIdAtom);

  const stillPresent = nextPath ? sorted.some((p) => p.path === nextPath) : false;

  if (!nextPath && sorted.length > 0) {
    nextPath = sorted[0].path;
  } else if (nextPath && !stillPresent) {
    nextPath = sorted[0]?.path ?? null;
    nextSession = null;
  }
  // else: stored path is still present — keep it.

  if (nextPath && nextSession) {
    const project = sorted.find((p) => p.path === nextPath);
    const exists = (project?.sessions ?? []).some((s) => s.id === nextSession);
    if (!exists) nextSession = null;
  }

  set(projectsAtom, sorted);
  set(selectedProjectPathAtom, nextPath);
  set(selectedSessionIdAtom, nextSession);
  set(lastSyncAtAtom, Date.now());
});

// Select a project, clearing the session selection (matches old Zustand `selectProject`).
export const selectProjectAtom = atom(null, (_get, set, path: string | null) => {
  set(selectedProjectPathAtom, path);
  set(selectedSessionIdAtom, null);
});
