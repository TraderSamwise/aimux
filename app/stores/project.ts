import { atom } from "jotai";
import { atomFamily } from "jotai/utils";
import type {
  GraveyardEntryResponse,
  ProjectObservabilityResponse,
  TaskSummaryResponse,
  ThreadSummaryResponse,
  WorktreeGraveyardEntryResponse,
} from "@/lib/api";

export type ProjectObservabilityModel = ProjectObservabilityResponse["project"];

export interface ProjectObservabilityValue {
  project: ProjectObservabilityModel;
  fetchedAt: string;
}

export interface ProjectTasksValue {
  tasks: TaskSummaryResponse[];
  fetchedAt: string;
}

export interface ProjectThreadsValue {
  threads: ThreadSummaryResponse[];
  fetchedAt: string;
}

export interface ProjectGraveyardValue {
  entries: GraveyardEntryResponse[];
  worktrees: WorktreeGraveyardEntryResponse[];
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
  requestKey: string;
  observability: ProjectObservabilityValue;
  updatedAt?: number;
}

export interface ApplyProjectResourceFailureInput {
  projectPath: string;
  requestKey: string;
  error: string;
}

export interface ApplyProjectResourceActionFailureInput {
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
  requestKey: string;
  tasks: ProjectTasksValue;
  updatedAt?: number;
}

export interface ApplyProjectThreadsSuccessInput {
  projectPath: string;
  requestKey: string;
  threads: ProjectThreadsValue;
  updatedAt?: number;
}

export interface ApplyProjectGraveyardSuccessInput {
  projectPath: string;
  requestKey: string;
  graveyard: ProjectGraveyardValue;
  updatedAt?: number;
}

const projectResourceRequestScope = `${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2)}`;
let projectResourceRequestSequence = 0;

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

export const projectThreadsResourceFamily = atomFamily((_projectPath: string) =>
  atom<ProjectResource<ProjectThreadsValue>>(emptyResource<ProjectThreadsValue>()),
);

export const projectGraveyardResourceFamily = atomFamily((_projectPath: string) =>
  atom<ProjectResource<ProjectGraveyardValue>>(emptyResource<ProjectGraveyardValue>()),
);

export const projectObservabilityFamily = atomFamily((projectPath: string) =>
  atom((get) => get(projectObservabilityResourceFamily(projectPath)).value),
);

export const projectTasksFamily = atomFamily((projectPath: string) =>
  atom((get) => get(projectTasksResourceFamily(projectPath)).value),
);

export const projectThreadsFamily = atomFamily((projectPath: string) =>
  atom((get) => get(projectThreadsResourceFamily(projectPath)).value),
);

export const projectGraveyardFamily = atomFamily((projectPath: string) =>
  atom((get) => get(projectGraveyardResourceFamily(projectPath)).value),
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

export const beginProjectThreadsRefreshAtom = atom(
  null,
  (get, set, { projectPath, requestKey }: BeginProjectResourceRefreshInput) => {
    const current = get(projectThreadsResourceFamily(projectPath));
    set(projectThreadsResourceFamily(projectPath), {
      ...current,
      pending: true,
      pendingRequestKey: requestKey,
      stale: current.value !== null,
    });
  },
);

export const beginProjectGraveyardRefreshAtom = atom(
  null,
  (get, set, { projectPath, requestKey }: BeginProjectResourceRefreshInput) => {
    const current = get(projectGraveyardResourceFamily(projectPath));
    set(projectGraveyardResourceFamily(projectPath), {
      ...current,
      pending: true,
      pendingRequestKey: requestKey,
      stale: current.value !== null,
    });
  },
);

export const applyProjectObservabilitySuccessAtom = atom(
  null,
  (
    get,
    set,
    { projectPath, requestKey, observability, updatedAt }: ApplyProjectObservabilitySuccessInput,
  ) => {
    const current = get(projectObservabilityResourceFamily(projectPath));
    if (current.pendingRequestKey !== requestKey) return;
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
  (get, set, { projectPath, requestKey, tasks, updatedAt }: ApplyProjectTasksSuccessInput) => {
    const current = get(projectTasksResourceFamily(projectPath));
    if (current.pendingRequestKey !== requestKey) return;
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

export const applyProjectThreadsSuccessAtom = atom(
  null,
  (get, set, { projectPath, requestKey, threads, updatedAt }: ApplyProjectThreadsSuccessInput) => {
    const current = get(projectThreadsResourceFamily(projectPath));
    if (current.pendingRequestKey !== requestKey) return;
    set(projectThreadsResourceFamily(projectPath), {
      value: threads,
      error: null,
      pending: false,
      pendingRequestKey: null,
      stale: false,
      updatedAt: updatedAt ?? Date.now(),
    });
  },
);

export const applyProjectGraveyardSuccessAtom = atom(
  null,
  (
    get,
    set,
    { projectPath, requestKey, graveyard, updatedAt }: ApplyProjectGraveyardSuccessInput,
  ) => {
    const current = get(projectGraveyardResourceFamily(projectPath));
    if (current.pendingRequestKey !== requestKey) return;
    set(projectGraveyardResourceFamily(projectPath), {
      value: graveyard,
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
  (get, set, { projectPath, requestKey, error }: ApplyProjectResourceFailureInput) => {
    const current = get(projectObservabilityResourceFamily(projectPath));
    if (current.pendingRequestKey !== requestKey) return;
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
  (get, set, { projectPath, requestKey, error }: ApplyProjectResourceFailureInput) => {
    const current = get(projectTasksResourceFamily(projectPath));
    if (current.pendingRequestKey !== requestKey) return;
    set(projectTasksResourceFamily(projectPath), {
      ...current,
      error,
      pending: false,
      pendingRequestKey: null,
      stale: current.value !== null,
    });
  },
);

export const applyProjectThreadsFailureAtom = atom(
  null,
  (get, set, { projectPath, requestKey, error }: ApplyProjectResourceFailureInput) => {
    const current = get(projectThreadsResourceFamily(projectPath));
    if (current.pendingRequestKey !== requestKey) return;
    set(projectThreadsResourceFamily(projectPath), {
      ...current,
      error,
      pending: false,
      pendingRequestKey: null,
      stale: current.value !== null,
    });
  },
);

export const applyProjectGraveyardFailureAtom = atom(
  null,
  (get, set, { projectPath, requestKey, error }: ApplyProjectResourceFailureInput) => {
    const current = get(projectGraveyardResourceFamily(projectPath));
    if (current.pendingRequestKey !== requestKey) return;
    set(projectGraveyardResourceFamily(projectPath), {
      ...current,
      error,
      pending: false,
      pendingRequestKey: null,
      stale: current.value !== null,
    });
  },
);

export const applyProjectGraveyardActionFailureAtom = atom(
  null,
  (get, set, { projectPath, error }: ApplyProjectResourceActionFailureInput) => {
    const current = get(projectGraveyardResourceFamily(projectPath));
    set(projectGraveyardResourceFamily(projectPath), {
      ...current,
      error,
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

export const clearProjectThreadsResourceAtom = atom(null, (_get, set, projectPath: string) => {
  set(projectThreadsResourceFamily(projectPath), emptyResource());
});

export const clearProjectGraveyardResourceAtom = atom(null, (_get, set, projectPath: string) => {
  set(projectGraveyardResourceFamily(projectPath), emptyResource());
});

export const removeProjectGraveyardAgentAtom = atom(
  null,
  (_get, set, { projectPath, id }: { projectPath: string; id: string }) => {
    set(projectGraveyardResourceFamily(projectPath), (current) =>
      current.value
        ? {
            ...current,
            value: {
              ...current.value,
              entries: current.value.entries.filter((entry) => entry.id !== id),
            },
            error: null,
          }
        : current,
    );
  },
);

export const removeProjectGraveyardWorktreeAtom = atom(
  null,
  (_get, set, { projectPath, path }: { projectPath: string; path: string }) => {
    set(projectGraveyardResourceFamily(projectPath), (current) =>
      current.value
        ? {
            ...current,
            value: {
              ...current.value,
              worktrees: current.value.worktrees.filter((entry) => entry.path !== path),
            },
            error: null,
          }
        : current,
    );
  },
);

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

export const settleProjectThreadsRefreshAtom = atom(
  null,
  (get, set, { projectPath, requestKey }: SettleProjectResourceRefreshInput) => {
    const current = get(projectThreadsResourceFamily(projectPath));
    if (current.pendingRequestKey !== requestKey) return;
    set(projectThreadsResourceFamily(projectPath), {
      ...current,
      pending: false,
      pendingRequestKey: null,
      stale: current.value !== null,
    });
  },
);

export const settleProjectGraveyardRefreshAtom = atom(
  null,
  (get, set, { projectPath, requestKey }: SettleProjectResourceRefreshInput) => {
    const current = get(projectGraveyardResourceFamily(projectPath));
    if (current.pendingRequestKey !== requestKey) return;
    set(projectGraveyardResourceFamily(projectPath), {
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
  sequence = ++projectResourceRequestSequence,
): string {
  return `${request.projectPath}\u0000${request.endpointKey ?? ""}\u0000${request.generation}\u0000${projectResourceRequestScope}\u0000${sequence}`;
}
