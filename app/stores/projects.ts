import { atom } from "jotai";
import type { DaemonProject, ProjectSession } from "@/lib/api";

// ─── Base atoms ────────────────────────────────────────────────────────────

export const projectsAtom = atom<DaemonProject[]>([]);
export const selectedProjectPathAtom = atom<string | null>(null);
export const selectedSessionIdAtom = atom<string | null>(null);
export const lastSyncAtAtom = atom<number | null>(null);

// ─── Derived atoms ─────────────────────────────────────────────────────────

export const selectedProjectAtom = atom<DaemonProject | null>((get) => {
  const path = get(selectedProjectPathAtom);
  if (!path) return null;
  return get(projectsAtom).find((p) => p.path === path) ?? null;
});

export const selectedSessionAtom = atom<ProjectSession | null>((get) => {
  const project = get(selectedProjectAtom);
  const sessionId = get(selectedSessionIdAtom);
  if (!project || !sessionId) return null;
  return project.sessions.find((s) => s.id === sessionId) ?? null;
});

// ─── Action atoms ──────────────────────────────────────────────────────────

// Reconcile a fresh project snapshot from the daemon. Sorts by name, auto-selects
// the first project if none is selected, clears stale session selection when the
// selected project disappears or the selected session is no longer present.
// Mirrors desktop-ui/src/stores/state.svelte.js:1353-1411 behavior.
export const reconcileProjectsAtom = atom(null, (get, set, incoming: DaemonProject[]) => {
  const sorted = [...incoming].sort((a, b) => a.name.localeCompare(b.name));
  let nextPath = get(selectedProjectPathAtom);
  let nextSession = get(selectedSessionIdAtom);

  if (!nextPath && sorted.length > 0) {
    nextPath = sorted[0].path;
  } else if (nextPath && !sorted.some((p) => p.path === nextPath)) {
    nextPath = sorted[0]?.path ?? null;
    nextSession = null;
  }

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
