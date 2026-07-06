import { atom } from "jotai";
import { atomFamily } from "jotai/utils";
import type { ProjectObservabilityResponse, TaskSummaryResponse } from "@/lib/api";

export type ProjectObservabilityModel = ProjectObservabilityResponse["project"];

export interface ProjectObservabilityValue {
  project: ProjectObservabilityModel;
  fetchedAt: string;
}

export interface ProjectTasksValue {
  tasks: TaskSummaryResponse[];
  fetchedAt: string;
}

export interface ProjectResource<T> {
  value: T | null;
  error: string | null;
  pending: boolean;
  pendingRequestKey: string | null;
  stale: boolean;
  updatedAt: number | null;
}

export interface ProjectResourceRequestScope {
  projectPath: string;
  endpointKey: string | null;
  generation: number;
}

export interface ApplyProjectObservabilitySuccessInput {
  projectPath: string;
  observability: ProjectObservabilityValue;
  updatedAt?: number;
}

export interface ApplyProjectResourceFailureInput {
  projectPath: string;
  error: string;
}

export interface BeginProjectResourceRefreshInput {
  projectPath: string;
  requestKey: string;
}

export interface SettleProjectResourceRefreshInput {
  projectPath: string;
  requestKey: string;
}

export interface ApplyProjectTasksSuccessInput {
  projectPath: string;
  tasks: ProjectTasksValue;
  updatedAt?: number;
}

export function emptyProjectObservability(): ProjectObservabilityModel {
  return {
    summary: {
      agentsRunning: 0,
      agentsWaiting: 0,
      agentsOffline: 0,
      services: 0,
      worktrees: 0,
      openTasks: 0,
      doneTasks: 0,
      unreadNotifications: 0,
    },
    progress: {
      pending: 0,
      assigned: 0,
      in_progress: 0,
      blocked: 0,
      done: 0,
      failed: 0,
      total: 0,
    },
    story: [],
  };
}

const emptyResource = <T>(): ProjectResource<T> => ({
  value: null,
  error: null,
  pending: false,
  pendingRequestKey: null,
  stale: false,
  updatedAt: null,
});

export const projectObservabilityResourceFamily = atomFamily((_projectPath: string) =>
  atom<ProjectResource<ProjectObservabilityValue>>(emptyResource<ProjectObservabilityValue>()),
);

export const projectTasksResourceFamily = atomFamily((_projectPath: string) =>
  atom<ProjectResource<ProjectTasksValue>>(emptyResource<ProjectTasksValue>()),
);

export const projectObservabilityFamily = atomFamily((projectPath: string) =>
  atom((get) => get(projectObservabilityResourceFamily(projectPath)).value),
);

export const projectTasksFamily = atomFamily((projectPath: string) =>
  atom((get) => get(projectTasksResourceFamily(projectPath)).value),
);

export const beginProjectObservabilityRefreshAtom = atom(
  null,
  (get, set, { projectPath, requestKey }: BeginProjectResourceRefreshInput) => {
    const current = get(projectObservabilityResourceFamily(projectPath));
    set(projectObservabilityResourceFamily(projectPath), {
      ...current,
      pending: true,
      pendingRequestKey: requestKey,
      stale: current.value !== null,
    });
  },
);

export const beginProjectTasksRefreshAtom = atom(
  null,
  (get, set, { projectPath, requestKey }: BeginProjectResourceRefreshInput) => {
    const current = get(projectTasksResourceFamily(projectPath));
    set(projectTasksResourceFamily(projectPath), {
      ...current,
      pending: true,
      pendingRequestKey: requestKey,
      stale: current.value !== null,
    });
  },
);

export const applyProjectObservabilitySuccessAtom = atom(
  null,
  (_get, set, { projectPath, observability, updatedAt }: ApplyProjectObservabilitySuccessInput) => {
    set(projectObservabilityResourceFamily(projectPath), {
      value: observability,
      error: null,
      pending: false,
      pendingRequestKey: null,
      stale: false,
      updatedAt: updatedAt ?? Date.now(),
    });
  },
);

export const applyProjectTasksSuccessAtom = atom(
  null,
  (_get, set, { projectPath, tasks, updatedAt }: ApplyProjectTasksSuccessInput) => {
    set(projectTasksResourceFamily(projectPath), {
      value: tasks,
      error: null,
      pending: false,
      pendingRequestKey: null,
      stale: false,
      updatedAt: updatedAt ?? Date.now(),
    });
  },
);

export const applyProjectObservabilityFailureAtom = atom(
  null,
  (get, set, { projectPath, error }: ApplyProjectResourceFailureInput) => {
    const current = get(projectObservabilityResourceFamily(projectPath));
    set(projectObservabilityResourceFamily(projectPath), {
      ...current,
      error,
      pending: false,
      pendingRequestKey: null,
      stale: current.value !== null,
    });
  },
);

export const applyProjectTasksFailureAtom = atom(
  null,
  (get, set, { projectPath, error }: ApplyProjectResourceFailureInput) => {
    const current = get(projectTasksResourceFamily(projectPath));
    set(projectTasksResourceFamily(projectPath), {
      ...current,
      error,
      pending: false,
      pendingRequestKey: null,
      stale: current.value !== null,
    });
  },
);

export const clearProjectObservabilityResourceAtom = atom(
  null,
  (_get, set, projectPath: string) => {
    set(projectObservabilityResourceFamily(projectPath), emptyResource());
  },
);

export const clearProjectTasksResourceAtom = atom(null, (_get, set, projectPath: string) => {
  set(projectTasksResourceFamily(projectPath), emptyResource());
});

export const settleProjectObservabilityRefreshAtom = atom(
  null,
  (get, set, { projectPath, requestKey }: SettleProjectResourceRefreshInput) => {
    const current = get(projectObservabilityResourceFamily(projectPath));
    if (current.pendingRequestKey !== requestKey) return;
    set(projectObservabilityResourceFamily(projectPath), {
      ...current,
      pending: false,
      pendingRequestKey: null,
      stale: current.value !== null,
    });
  },
);

export const settleProjectTasksRefreshAtom = atom(
  null,
  (get, set, { projectPath, requestKey }: SettleProjectResourceRefreshInput) => {
    const current = get(projectTasksResourceFamily(projectPath));
    if (current.pendingRequestKey !== requestKey) return;
    set(projectTasksResourceFamily(projectPath), {
      ...current,
      pending: false,
      pendingRequestKey: null,
      stale: current.value !== null,
    });
  },
);

export function isCurrentProjectResourceRequest(
  request: ProjectResourceRequestScope,
  current: ProjectResourceRequestScope,
): boolean {
  return (
    request.projectPath === current.projectPath &&
    request.endpointKey === current.endpointKey &&
    request.generation === current.generation
  );
}

export function projectResourceRequestKey(
  request: ProjectResourceRequestScope,
  sequence: number,
): string {
  return `${request.projectPath}\u0000${request.endpointKey ?? ""}\u0000${request.generation}\u0000${sequence}`;
}
