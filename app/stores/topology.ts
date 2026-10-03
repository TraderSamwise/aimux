import { atom } from "jotai";
import type { ProjectStateKey } from "@/lib/project-key";
import { atomFamily } from "jotai/utils";
import type { ProjectTopologyResponse } from "@/lib/api";

export type TopologyValue = ProjectTopologyResponse["topology"] & {
  fetchedAt: string;
};

export interface TopologyResource {
  value: TopologyValue | null;
  error: string | null;
  pending: boolean;
  stale: boolean;
  updatedAt: number | null;
}

export interface ApplyTopologySuccessInput {
  projectStateKey: ProjectStateKey;
  topology: TopologyValue;
  updatedAt?: number;
}

export interface ApplyTopologyFailureInput {
  projectStateKey: ProjectStateKey;
  error: string;
}

export interface TopologyRequestScope {
  projectStateKey: ProjectStateKey;
  endpointKey: string | null;
  generation: number;
}

const emptyTopologyResource = (): TopologyResource => ({
  value: null,
  error: null,
  pending: false,
  stale: false,
  updatedAt: null,
});

export const topologyResourceFamily = atomFamily((_projectStateKey: ProjectStateKey) =>
  atom<TopologyResource>(emptyTopologyResource()),
);

export const topologyFamily = atomFamily((projectStateKey: ProjectStateKey) =>
  atom((get) => get(topologyResourceFamily(projectStateKey)).value),
);

export const topologyErrorFamily = atomFamily((projectStateKey: ProjectStateKey) =>
  atom((get) => get(topologyResourceFamily(projectStateKey)).error),
);

export const beginTopologyRefreshAtom = atom(null, (get, set, projectStateKey: ProjectStateKey) => {
  const current = get(topologyResourceFamily(projectStateKey));
  set(topologyResourceFamily(projectStateKey), {
    ...current,
    pending: true,
    stale: current.value !== null,
  });
});

export const applyTopologySuccessAtom = atom(
  null,
  (_get, set, { projectStateKey, topology, updatedAt }: ApplyTopologySuccessInput) => {
    set(topologyResourceFamily(projectStateKey), {
      value: topology,
      error: null,
      pending: false,
      stale: false,
      updatedAt: updatedAt ?? Date.now(),
    });
  },
);

export const applyTopologyFailureAtom = atom(
  null,
  (get, set, { projectStateKey, error }: ApplyTopologyFailureInput) => {
    const current = get(topologyResourceFamily(projectStateKey));
    set(topologyResourceFamily(projectStateKey), {
      ...current,
      error,
      pending: false,
      stale: current.value !== null,
    });
  },
);

export const settleTopologyRefreshAtom = atom(
  null,
  (get, set, projectStateKey: ProjectStateKey) => {
    const current = get(topologyResourceFamily(projectStateKey));
    set(topologyResourceFamily(projectStateKey), {
      ...current,
      pending: false,
      stale: current.value !== null && current.stale,
    });
  },
);

export const clearTopologyResourceAtom = atom(
  null,
  (_get, set, projectStateKey: ProjectStateKey) => {
    set(topologyResourceFamily(projectStateKey), emptyTopologyResource());
  },
);

export function isCurrentTopologyRequest(
  request: TopologyRequestScope,
  current: TopologyRequestScope,
): boolean {
  return (
    request.projectStateKey === current.projectStateKey &&
    request.endpointKey === current.endpointKey &&
    request.generation === current.generation
  );
}
