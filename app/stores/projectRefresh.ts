import { atom } from "jotai";
import { getProjectObservability, listTasks } from "@/lib/api";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import type { ProjectResourceRequestMarker } from "@/lib/project-resource-request-tracker";
import {
  applyProjectObservabilityFailureAtom,
  applyProjectObservabilitySuccessAtom,
  applyProjectTasksFailureAtom,
  applyProjectTasksSuccessAtom,
  beginProjectObservabilityRefreshAtom,
  beginProjectTasksRefreshAtom,
  clearProjectObservabilityResourceAtom,
  clearProjectTasksResourceAtom,
  settleProjectObservabilityRefreshAtom,
  settleProjectTasksRefreshAtom,
} from "@/stores/project";

export interface RefreshProjectApiResourceInput {
  endpoint: ServiceEndpoint | null;
  getToken: () => Promise<string | null>;
  isCurrentRequest: (marker: ProjectResourceRequestMarker) => boolean;
  request: ProjectResourceRequestMarker;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const refreshProjectObservabilityResourceAtom = atom(
  null,
  async (
    _get,
    set,
    { endpoint, getToken, isCurrentRequest, request }: RefreshProjectApiResourceInput,
  ) => {
    const projectPath = request.scope.projectPath;
    const requestKey = request.requestKey;
    if (!endpoint) {
      set(clearProjectObservabilityResourceAtom, projectPath);
      return;
    }
    set(beginProjectObservabilityRefreshAtom, { projectPath, requestKey });
    try {
      const token = await getToken();
      const response = await getProjectObservability(endpoint, { token });
      if (!isCurrentRequest(request)) {
        set(settleProjectObservabilityRefreshAtom, { projectPath, requestKey });
        return;
      }
      set(applyProjectObservabilitySuccessAtom, {
        projectPath,
        requestKey,
        observability: {
          project: response.project,
          fetchedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      if (!isCurrentRequest(request)) {
        set(settleProjectObservabilityRefreshAtom, { projectPath, requestKey });
        return;
      }
      set(applyProjectObservabilityFailureAtom, {
        projectPath,
        requestKey,
        error: errorMessage(err),
      });
    }
  },
);

export const refreshProjectTasksResourceAtom = atom(
  null,
  async (
    _get,
    set,
    { endpoint, getToken, isCurrentRequest, request }: RefreshProjectApiResourceInput,
  ) => {
    const projectPath = request.scope.projectPath;
    const requestKey = request.requestKey;
    if (!endpoint) {
      set(clearProjectTasksResourceAtom, projectPath);
      return;
    }
    set(beginProjectTasksRefreshAtom, { projectPath, requestKey });
    try {
      const token = await getToken();
      const response = await listTasks(endpoint, undefined, { token });
      if (!isCurrentRequest(request)) {
        set(settleProjectTasksRefreshAtom, { projectPath, requestKey });
        return;
      }
      set(applyProjectTasksSuccessAtom, {
        projectPath,
        requestKey,
        tasks: {
          tasks: response.tasks,
          fetchedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      if (!isCurrentRequest(request)) {
        set(settleProjectTasksRefreshAtom, { projectPath, requestKey });
        return;
      }
      set(applyProjectTasksFailureAtom, {
        projectPath,
        requestKey,
        error: errorMessage(err),
      });
    }
  },
);
