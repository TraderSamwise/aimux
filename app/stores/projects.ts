import { create } from "zustand";
import type { DaemonProject } from "@/lib/api";

interface ProjectsState {
  projects: DaemonProject[];
  selectedProjectPath: string | null;
  selectedSessionId: string | null;
  lastSyncAt: number | null;
  setProjects: (incoming: DaemonProject[]) => void;
  selectProject: (path: string | null) => void;
  selectSession: (sessionId: string | null) => void;
}

export const useProjectsStore = create<ProjectsState>((set, get) => ({
  projects: [],
  selectedProjectPath: null,
  selectedSessionId: null,
  lastSyncAt: null,

  setProjects: (incoming: DaemonProject[]) => {
    const sorted = [...incoming].sort((a, b) => a.name.localeCompare(b.name));
    const current = get();

    let nextSelectedPath = current.selectedProjectPath;
    let nextSelectedSession = current.selectedSessionId;

    if (!nextSelectedPath && sorted.length > 0) {
      nextSelectedPath = sorted[0].path;
    } else if (nextSelectedPath && !sorted.some((p) => p.path === nextSelectedPath)) {
      nextSelectedPath = sorted[0]?.path ?? null;
      nextSelectedSession = null;
    }

    if (nextSelectedPath && nextSelectedSession) {
      const project = sorted.find((p) => p.path === nextSelectedPath);
      const exists = (project?.sessions ?? []).some((s) => s.id === nextSelectedSession);
      if (!exists) nextSelectedSession = null;
    }

    set({
      projects: sorted,
      selectedProjectPath: nextSelectedPath,
      selectedSessionId: nextSelectedSession,
      lastSyncAt: Date.now(),
    });
  },

  selectProject: (path) => set({ selectedProjectPath: path, selectedSessionId: null }),
  selectSession: (sessionId) => set({ selectedSessionId: sessionId }),
}));

export function selectedProjectFromState(state: ProjectsState): DaemonProject | null {
  if (!state.selectedProjectPath) return null;
  return state.projects.find((p) => p.path === state.selectedProjectPath) ?? null;
}

export function selectedSessionFromState(state: ProjectsState) {
  const project = selectedProjectFromState(state);
  if (!project || !state.selectedSessionId) return null;
  return project.sessions.find((s) => s.id === state.selectedSessionId) ?? null;
}
