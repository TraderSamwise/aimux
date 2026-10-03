import { atom } from "jotai";
import { getProjectObservability, listTasks } from "@/lib/api";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import type { ProjectResourceRequestMarker } from "@/lib/project-resource-request-tracker";
import { getErrorMessage, isTransientRequestError } from "@/lib/request-errors";
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

export const refreshProjectObservabilityResourceAtom = atom(
  null,
  async (
    _get,
    set,
    { endpoint, getToken, isCurrentRequest, request }: RefreshProjectApiResourceInput,
  ) => {
    const projectStateKey = request.scope.projectStateKey;
    const requestKey = request.requestKey;
    if (!endpoint) {
      set(clearProjectObservabilityResourceAtom, projectStateKey);
      return;
    }
    set(beginProjectObservabilityRefreshAtom, { projectStateKey, requestKey });
    try {
      const token = await getToken();
      const response = await getProjectObservability(endpoint, { token });
      if (!isCurrentRequest(request)) {
        set(settleProjectObservabilityRefreshAtom, { projectStateKey, requestKey });
        return;
      }
      set(applyProjectObservabilitySuccessAtom, {
        projectStateKey,
        requestKey,
        observability: {
          project: response.project,
          fetchedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      if (!isCurrentRequest(request)) {
        set(settleProjectObservabilityRefreshAtom, { projectStateKey, requestKey });
        return;
      }
      if (isTransientRequestError(err)) {
        set(settleProjectObservabilityRefreshAtom, { projectStateKey, requestKey });
      } else {
        set(applyProjectObservabilityFailureAtom, {
          projectStateKey,
          requestKey,
          error: getErrorMessage(err),
        });
      }
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
    const projectStateKey = request.scope.projectStateKey;
    const requestKey = request.requestKey;
    if (!endpoint) {
      set(clearProjectTasksResourceAtom, projectStateKey);
      return;
    }
    set(beginProjectTasksRefreshAtom, { projectStateKey, requestKey });
    try {
      const token = await getToken();
      const response = await listTasks(endpoint, undefined, { token });
      if (!isCurrentRequest(request)) {
        set(settleProjectTasksRefreshAtom, { projectStateKey, requestKey });
        return;
      }
      set(applyProjectTasksSuccessAtom, {
        projectStateKey,
        requestKey,
        tasks: {
          tasks: response.tasks,
          fetchedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      if (!isCurrentRequest(request)) {
        set(settleProjectTasksRefreshAtom, { projectStateKey, requestKey });
        return;
      }
      if (isTransientRequestError(err)) {
        set(settleProjectTasksRefreshAtom, { projectStateKey, requestKey });
      } else {
        set(applyProjectTasksFailureAtom, {
          projectStateKey,
          requestKey,
          error: getErrorMessage(err),
        });
      }
    }
  },
);
