import { atom } from "jotai";
import { getProjectObservability, listTasks } from "@/lib/api";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import {
  applyProjectObservabilityFailureAtom,
  applyProjectObservabilitySuccessAtom,
  applyProjectTasksFailureAtom,
  applyProjectTasksSuccessAtom,
  beginProjectObservabilityRefreshAtom,
  beginProjectTasksRefreshAtom,
  clearProjectObservabilityResourceAtom,
  clearProjectTasksResourceAtom,
  projectResourceRequestKey,
} from "@/stores/project";

export interface RefreshProjectApiResourceInput {
  projectPath: string;
  endpoint: ServiceEndpoint | null;
  getToken: () => Promise<string | null>;
}

function endpointKey(endpoint: ServiceEndpoint | null): string | null {
  return endpoint ? `${endpoint.host}:${endpoint.port}` : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const refreshProjectObservabilityResourceAtom = atom(
  null,
  async (_get, set, { projectPath, endpoint, getToken }: RefreshProjectApiResourceInput) => {
    if (!endpoint) {
      set(clearProjectObservabilityResourceAtom, projectPath);
      return;
    }
    const requestKey = projectResourceRequestKey({
      projectPath,
      endpointKey: endpointKey(endpoint),
      generation: 0,
    });
    set(beginProjectObservabilityRefreshAtom, { projectPath, requestKey });
    try {
      const token = await getToken();
      const response = await getProjectObservability(endpoint, { token });
      set(applyProjectObservabilitySuccessAtom, {
        projectPath,
        requestKey,
        observability: {
          project: response.project,
          fetchedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
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
  async (_get, set, { projectPath, endpoint, getToken }: RefreshProjectApiResourceInput) => {
    if (!endpoint) {
      set(clearProjectTasksResourceAtom, projectPath);
      return;
    }
    const requestKey = projectResourceRequestKey({
      projectPath,
      endpointKey: endpointKey(endpoint),
      generation: 0,
    });
    set(beginProjectTasksRefreshAtom, { projectPath, requestKey });
    try {
      const token = await getToken();
      const response = await listTasks(endpoint, undefined, { token });
      set(applyProjectTasksSuccessAtom, {
        projectPath,
        requestKey,
        tasks: {
          tasks: response.tasks,
          fetchedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      set(applyProjectTasksFailureAtom, {
        projectPath,
        requestKey,
        error: errorMessage(err),
      });
    }
  },
);
