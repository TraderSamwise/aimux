import { atom } from "jotai";
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
  projectPath: string;
  topology: TopologyValue;
  updatedAt?: number;
}

export interface ApplyTopologyFailureInput {
  projectPath: string;
  error: string;
}

export interface TopologyRequestScope {
  projectPath: string;
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

export const topologyResourceFamily = atomFamily((_projectPath: string) =>
  atom<TopologyResource>(emptyTopologyResource()),
);

export const topologyFamily = atomFamily((projectPath: string) =>
  atom((get) => get(topologyResourceFamily(projectPath)).value),
);

export const topologyErrorFamily = atomFamily((projectPath: string) =>
  atom((get) => get(topologyResourceFamily(projectPath)).error),
);

export const beginTopologyRefreshAtom = atom(null, (get, set, projectPath: string) => {
  const current = get(topologyResourceFamily(projectPath));
  set(topologyResourceFamily(projectPath), {
    ...current,
    pending: true,
    stale: current.value !== null,
  });
});

export const applyTopologySuccessAtom = atom(
  null,
  (_get, set, { projectPath, topology, updatedAt }: ApplyTopologySuccessInput) => {
    set(topologyResourceFamily(projectPath), {
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
  (get, set, { projectPath, error }: ApplyTopologyFailureInput) => {
    const current = get(topologyResourceFamily(projectPath));
    set(topologyResourceFamily(projectPath), {
      ...current,
      error,
      pending: false,
      stale: current.value !== null,
    });
  },
);

export const clearTopologyResourceAtom = atom(null, (_get, set, projectPath: string) => {
  set(topologyResourceFamily(projectPath), emptyTopologyResource());
});

export function isCurrentTopologyRequest(
  request: TopologyRequestScope,
  current: TopologyRequestScope,
): boolean {
  return (
    request.projectPath === current.projectPath &&
    request.endpointKey === current.endpointKey &&
    request.generation === current.generation
  );
}
