import { atom } from "jotai";
import type { ProjectStateKey } from "@/lib/project-key";
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

export interface ProjectPlanValue {
  sessionId: string;
  content: string;
  savedContent: string;
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
  projectStateKey: ProjectStateKey;
  endpointKey: string | null;
  generation: number;
}

export interface ApplyProjectObservabilitySuccessInput {
  projectStateKey: ProjectStateKey;
  requestKey: string;
  observability: ProjectObservabilityValue;
  updatedAt?: number;
}

export interface ApplyProjectResourceFailureInput {
  projectStateKey: ProjectStateKey;
  requestKey: string;
  error: string;
}

export interface ApplyProjectResourceActionFailureInput {
  projectStateKey: ProjectStateKey;
  error: string;
}

export interface BeginProjectResourceRefreshInput {
  projectStateKey: ProjectStateKey;
  requestKey: string;
}

export interface SettleProjectResourceRefreshInput {
  projectStateKey: ProjectStateKey;
  requestKey: string;
}

export interface ApplyProjectTasksSuccessInput {
  projectStateKey: ProjectStateKey;
  requestKey: string;
  tasks: ProjectTasksValue;
  updatedAt?: number;
}

export interface ApplyProjectThreadsSuccessInput {
  projectStateKey: ProjectStateKey;
  requestKey: string;
  threads: ProjectThreadsValue;
  updatedAt?: number;
}

export interface ApplyProjectGraveyardSuccessInput {
  projectStateKey: ProjectStateKey;
  requestKey: string;
  graveyard: ProjectGraveyardValue;
  updatedAt?: number;
}

export interface ApplyProjectPlanSuccessInput {
  planKey: string;
  requestKey: string;
  plan: {
    sessionId: string;
    content: string;
    fetchedAt: string;
  };
  updatedAt?: number;
}

export interface ApplyProjectPlanFailureInput {
  planKey: string;
  requestKey: string;
  error: string;
}

export interface ApplyProjectPlanActionFailureInput {
  planKey: string;
  error: string;
}

export interface ApplyProjectPlanEndpointUnavailableInput {
  planKey: string;
  error: string;
}

export interface BeginProjectPlanRefreshInput {
  planKey: string;
  requestKey: string;
}

export interface SettleProjectPlanRefreshInput {
  planKey: string;
  requestKey: string;
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
      canceled: 0,
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

export const projectObservabilityResourceFamily = atomFamily((_projectStateKey: ProjectStateKey) =>
  atom<ProjectResource<ProjectObservabilityValue>>(emptyResource<ProjectObservabilityValue>()),
);

export const projectTasksResourceFamily = atomFamily((_projectStateKey: ProjectStateKey) =>
  atom<ProjectResource<ProjectTasksValue>>(emptyResource<ProjectTasksValue>()),
);

export const projectThreadsResourceFamily = atomFamily((_projectStateKey: ProjectStateKey) =>
  atom<ProjectResource<ProjectThreadsValue>>(emptyResource<ProjectThreadsValue>()),
);

export const projectGraveyardResourceFamily = atomFamily((_projectStateKey: ProjectStateKey) =>
  atom<ProjectResource<ProjectGraveyardValue>>(emptyResource<ProjectGraveyardValue>()),
);

export const projectPlanResourceFamily = atomFamily((_planKey: string) =>
  atom<ProjectResource<ProjectPlanValue>>(emptyResource<ProjectPlanValue>()),
);

export const projectObservabilityFamily = atomFamily((projectStateKey: ProjectStateKey) =>
  atom((get) => get(projectObservabilityResourceFamily(projectStateKey)).value),
);

export const projectTasksFamily = atomFamily((projectStateKey: ProjectStateKey) =>
  atom((get) => get(projectTasksResourceFamily(projectStateKey)).value),
);

export const projectThreadsFamily = atomFamily((projectStateKey: ProjectStateKey) =>
  atom((get) => get(projectThreadsResourceFamily(projectStateKey)).value),
);

export const projectGraveyardFamily = atomFamily((projectStateKey: ProjectStateKey) =>
  atom((get) => get(projectGraveyardResourceFamily(projectStateKey)).value),
);

export const projectPlanFamily = atomFamily((planKey: string) =>
  atom((get) => get(projectPlanResourceFamily(planKey)).value),
);

// A plan belongs to a session inside a project, so it is keyed by both. The
// result is itself a project-scoped key: the plan families are indexed by it.
export function projectPlanResourceKey(
  projectStateKey: ProjectStateKey,
  sessionId: string,
): ProjectStateKey {
  return `${projectStateKey}\u0000${sessionId}` as ProjectStateKey;
}

export const beginProjectObservabilityRefreshAtom = atom(
  null,
  (get, set, { projectStateKey, requestKey }: BeginProjectResourceRefreshInput) => {
    const current = get(projectObservabilityResourceFamily(projectStateKey));
    set(projectObservabilityResourceFamily(projectStateKey), {
      ...current,
      error: null,
      pending: true,
      pendingRequestKey: requestKey,
      stale: current.value !== null,
    });
  },
);

export const beginProjectTasksRefreshAtom = atom(
  null,
  (get, set, { projectStateKey, requestKey }: BeginProjectResourceRefreshInput) => {
    const current = get(projectTasksResourceFamily(projectStateKey));
    set(projectTasksResourceFamily(projectStateKey), {
      ...current,
      error: null,
      pending: true,
      pendingRequestKey: requestKey,
      stale: current.value !== null,
    });
  },
);

export const beginProjectThreadsRefreshAtom = atom(
  null,
  (get, set, { projectStateKey, requestKey }: BeginProjectResourceRefreshInput) => {
    const current = get(projectThreadsResourceFamily(projectStateKey));
    set(projectThreadsResourceFamily(projectStateKey), {
      ...current,
      error: null,
      pending: true,
      pendingRequestKey: requestKey,
      stale: current.value !== null,
    });
  },
);

export const beginProjectGraveyardRefreshAtom = atom(
  null,
  (get, set, { projectStateKey, requestKey }: BeginProjectResourceRefreshInput) => {
    const current = get(projectGraveyardResourceFamily(projectStateKey));
    set(projectGraveyardResourceFamily(projectStateKey), {
      ...current,
      error: null,
      pending: true,
      pendingRequestKey: requestKey,
      stale: current.value !== null,
    });
  },
);

export const beginProjectPlanRefreshAtom = atom(
  null,
  (get, set, { planKey, requestKey }: BeginProjectPlanRefreshInput) => {
    const current = get(projectPlanResourceFamily(planKey));
    set(projectPlanResourceFamily(planKey), {
      ...current,
      error: null,
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
    {
      projectStateKey,
      requestKey,
      observability,
      updatedAt,
    }: ApplyProjectObservabilitySuccessInput,
  ) => {
    const current = get(projectObservabilityResourceFamily(projectStateKey));
    if (current.pendingRequestKey !== requestKey) return;
    set(projectObservabilityResourceFamily(projectStateKey), {
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
  (get, set, { projectStateKey, requestKey, tasks, updatedAt }: ApplyProjectTasksSuccessInput) => {
    const current = get(projectTasksResourceFamily(projectStateKey));
    if (current.pendingRequestKey !== requestKey) return;
    set(projectTasksResourceFamily(projectStateKey), {
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
  (
    get,
    set,
    { projectStateKey, requestKey, threads, updatedAt }: ApplyProjectThreadsSuccessInput,
  ) => {
    const current = get(projectThreadsResourceFamily(projectStateKey));
    if (current.pendingRequestKey !== requestKey) return;
    set(projectThreadsResourceFamily(projectStateKey), {
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
    { projectStateKey, requestKey, graveyard, updatedAt }: ApplyProjectGraveyardSuccessInput,
  ) => {
    const current = get(projectGraveyardResourceFamily(projectStateKey));
    if (current.pendingRequestKey !== requestKey) return;
    set(projectGraveyardResourceFamily(projectStateKey), {
      value: graveyard,
      error: null,
      pending: false,
      pendingRequestKey: null,
      stale: false,
      updatedAt: updatedAt ?? Date.now(),
    });
  },
);

export const applyProjectPlanSuccessAtom = atom(
  null,
  (get, set, { planKey, requestKey, plan, updatedAt }: ApplyProjectPlanSuccessInput) => {
    const current = get(projectPlanResourceFamily(planKey));
    if (current.pendingRequestKey !== requestKey) return;
    const currentDraft = current.value;
    const hasUnsavedDraft =
      currentDraft !== null && currentDraft.content !== currentDraft.savedContent;
    const nextContent = hasUnsavedDraft ? currentDraft.content : plan.content;
    set(projectPlanResourceFamily(planKey), {
      value: {
        sessionId: plan.sessionId,
        content: nextContent,
        savedContent: plan.content,
        fetchedAt: plan.fetchedAt,
      },
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
  (get, set, { projectStateKey, requestKey, error }: ApplyProjectResourceFailureInput) => {
    const current = get(projectObservabilityResourceFamily(projectStateKey));
    if (current.pendingRequestKey !== requestKey) return;
    set(projectObservabilityResourceFamily(projectStateKey), {
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
  (get, set, { projectStateKey, requestKey, error }: ApplyProjectResourceFailureInput) => {
    const current = get(projectTasksResourceFamily(projectStateKey));
    if (current.pendingRequestKey !== requestKey) return;
    set(projectTasksResourceFamily(projectStateKey), {
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
  (get, set, { projectStateKey, requestKey, error }: ApplyProjectResourceFailureInput) => {
    const current = get(projectThreadsResourceFamily(projectStateKey));
    if (current.pendingRequestKey !== requestKey) return;
    set(projectThreadsResourceFamily(projectStateKey), {
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
  (get, set, { projectStateKey, requestKey, error }: ApplyProjectResourceFailureInput) => {
    const current = get(projectGraveyardResourceFamily(projectStateKey));
    if (current.pendingRequestKey !== requestKey) return;
    set(projectGraveyardResourceFamily(projectStateKey), {
      ...current,
      error,
      pending: false,
      pendingRequestKey: null,
      stale: current.value !== null,
    });
  },
);

export const applyProjectPlanFailureAtom = atom(
  null,
  (get, set, { planKey, requestKey, error }: ApplyProjectPlanFailureInput) => {
    const current = get(projectPlanResourceFamily(planKey));
    if (current.pendingRequestKey !== requestKey) return;
    set(projectPlanResourceFamily(planKey), {
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
  (get, set, { projectStateKey, error }: ApplyProjectResourceActionFailureInput) => {
    const current = get(projectGraveyardResourceFamily(projectStateKey));
    set(projectGraveyardResourceFamily(projectStateKey), {
      ...current,
      error,
      stale: current.value !== null,
    });
  },
);

export const applyProjectPlanActionFailureAtom = atom(
  null,
  (get, set, { planKey, error }: ApplyProjectPlanActionFailureInput) => {
    const current = get(projectPlanResourceFamily(planKey));
    set(projectPlanResourceFamily(planKey), {
      ...current,
      error,
      stale: current.value !== null,
    });
  },
);

export const applyProjectPlanEndpointUnavailableAtom = atom(
  null,
  (get, set, { planKey, error }: ApplyProjectPlanEndpointUnavailableInput) => {
    const current = get(projectPlanResourceFamily(planKey));
    set(projectPlanResourceFamily(planKey), {
      ...current,
      error,
      pending: false,
      pendingRequestKey: null,
      stale: current.value !== null,
    });
  },
);

export const editProjectPlanDraftAtom = atom(
  null,
  (
    get,
    set,
    { planKey, sessionId, content }: { planKey: string; sessionId: string; content: string },
  ) => {
    const current = get(projectPlanResourceFamily(planKey));
    const currentValue = current.value;
    set(projectPlanResourceFamily(planKey), {
      ...current,
      value: {
        sessionId,
        content,
        savedContent: currentValue?.savedContent ?? "",
        fetchedAt: currentValue?.fetchedAt ?? new Date(0).toISOString(),
      },
      error: null,
      stale: current.value !== null ? current.stale : false,
      updatedAt: current.updatedAt ?? Date.now(),
    });
  },
);

export const applyProjectPlanSaveSuccessAtom = atom(
  null,
  (
    get,
    set,
    {
      planKey,
      sessionId,
      content,
      updatedAt,
    }: { planKey: string; sessionId: string; content: string; updatedAt?: number },
  ) => {
    const current = get(projectPlanResourceFamily(planKey));
    const currentValue = current.value;
    const nextContent =
      currentValue && currentValue.content !== content ? currentValue.content : content;
    set(projectPlanResourceFamily(planKey), {
      ...current,
      value: {
        sessionId,
        content: nextContent,
        savedContent: content,
        fetchedAt: new Date(updatedAt ?? Date.now()).toISOString(),
      },
      error: null,
      stale: false,
      updatedAt: updatedAt ?? Date.now(),
    });
  },
);

export const clearProjectObservabilityResourceAtom = atom(
  null,
  (_get, set, projectStateKey: ProjectStateKey) => {
    set(projectObservabilityResourceFamily(projectStateKey), emptyResource());
  },
);

export const clearProjectTasksResourceAtom = atom(
  null,
  (_get, set, projectStateKey: ProjectStateKey) => {
    set(projectTasksResourceFamily(projectStateKey), emptyResource());
  },
);

export const clearProjectThreadsResourceAtom = atom(
  null,
  (_get, set, projectStateKey: ProjectStateKey) => {
    set(projectThreadsResourceFamily(projectStateKey), emptyResource());
  },
);

export const clearProjectGraveyardResourceAtom = atom(
  null,
  (_get, set, projectStateKey: ProjectStateKey) => {
    set(projectGraveyardResourceFamily(projectStateKey), emptyResource());
  },
);

export const clearProjectPlanResourceAtom = atom(null, (_get, set, planKey: string) => {
  set(projectPlanResourceFamily(planKey), emptyResource());
});

export const removeProjectGraveyardAgentAtom = atom(
  null,
  (_get, set, { projectStateKey, id }: { projectStateKey: ProjectStateKey; id: string }) => {
    set(projectGraveyardResourceFamily(projectStateKey), (current) =>
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
  (_get, set, { projectStateKey, path }: { projectStateKey: ProjectStateKey; path: string }) => {
    set(projectGraveyardResourceFamily(projectStateKey), (current) =>
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
  (get, set, { projectStateKey, requestKey }: SettleProjectResourceRefreshInput) => {
    const current = get(projectObservabilityResourceFamily(projectStateKey));
    if (current.pendingRequestKey !== requestKey) return;
    set(projectObservabilityResourceFamily(projectStateKey), {
      ...current,
      pending: false,
      pendingRequestKey: null,
      stale: current.value !== null,
    });
  },
);

export const settleProjectTasksRefreshAtom = atom(
  null,
  (get, set, { projectStateKey, requestKey }: SettleProjectResourceRefreshInput) => {
    const current = get(projectTasksResourceFamily(projectStateKey));
    if (current.pendingRequestKey !== requestKey) return;
    set(projectTasksResourceFamily(projectStateKey), {
      ...current,
      pending: false,
      pendingRequestKey: null,
      stale: current.value !== null,
    });
  },
);

export const settleProjectThreadsRefreshAtom = atom(
  null,
  (get, set, { projectStateKey, requestKey }: SettleProjectResourceRefreshInput) => {
    const current = get(projectThreadsResourceFamily(projectStateKey));
    if (current.pendingRequestKey !== requestKey) return;
    set(projectThreadsResourceFamily(projectStateKey), {
      ...current,
      pending: false,
      pendingRequestKey: null,
      stale: current.value !== null,
    });
  },
);

export const settleProjectGraveyardRefreshAtom = atom(
  null,
  (get, set, { projectStateKey, requestKey }: SettleProjectResourceRefreshInput) => {
    const current = get(projectGraveyardResourceFamily(projectStateKey));
    if (current.pendingRequestKey !== requestKey) return;
    set(projectGraveyardResourceFamily(projectStateKey), {
      ...current,
      pending: false,
      pendingRequestKey: null,
      stale: current.value !== null,
    });
  },
);

export const settleProjectPlanRefreshAtom = atom(
  null,
  (get, set, { planKey, requestKey }: SettleProjectPlanRefreshInput) => {
    const current = get(projectPlanResourceFamily(planKey));
    if (current.pendingRequestKey !== requestKey) return;
    set(projectPlanResourceFamily(planKey), {
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
    request.projectStateKey === current.projectStateKey &&
    request.endpointKey === current.endpointKey &&
    request.generation === current.generation
  );
}

export function projectResourceRequestKey(
  request: ProjectResourceRequestScope,
  sequence = ++projectResourceRequestSequence,
): string {
  return `${request.projectStateKey}\u0000${request.endpointKey ?? ""}\u0000${request.generation}\u0000${projectResourceRequestScope}\u0000${sequence}`;
}
