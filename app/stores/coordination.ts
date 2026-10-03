import { atom } from "jotai";
import type { ProjectStateKey } from "@/lib/project-key";
import { atomFamily } from "jotai/utils";
import type { CoordinationWorklistItem } from "@/lib/api";

export interface CoordinationWorklistValue {
  items: CoordinationWorklistItem[];
  fetchedAt: string;
}

export interface CoordinationWorklistResource {
  value: CoordinationWorklistValue | null;
  error: string | null;
  pending: boolean;
  stale: boolean;
  updatedAt: number | null;
}

export interface ApplyCoordinationWorklistSuccessInput {
  projectStateKey: ProjectStateKey;
  worklist: CoordinationWorklistValue;
  updatedAt?: number;
}

export interface ApplyCoordinationWorklistFailureInput {
  projectStateKey: ProjectStateKey;
  error: string;
}

export interface CoordinationWorklistRequestScope {
  projectStateKey: ProjectStateKey;
  endpointKey: string | null;
  generation: number;
}

const emptyCoordinationWorklistResource = (): CoordinationWorklistResource => ({
  value: null,
  error: null,
  pending: false,
  stale: false,
  updatedAt: null,
});

export const coordinationWorklistResourceFamily = atomFamily((_projectStateKey: ProjectStateKey) =>
  atom<CoordinationWorklistResource>(emptyCoordinationWorklistResource()),
);

export const coordinationWorklistFamily = atomFamily((projectStateKey: ProjectStateKey) =>
  atom((get) => get(coordinationWorklistResourceFamily(projectStateKey)).value),
);

export const coordinationWorklistErrorFamily = atomFamily((projectStateKey: ProjectStateKey) =>
  atom((get) => get(coordinationWorklistResourceFamily(projectStateKey)).error),
);

export const beginCoordinationWorklistRefreshAtom = atom(
  null,
  (get, set, projectStateKey: ProjectStateKey) => {
    const current = get(coordinationWorklistResourceFamily(projectStateKey));
    set(coordinationWorklistResourceFamily(projectStateKey), {
      ...current,
      pending: true,
      stale: current.value !== null,
    });
  },
);

export const applyCoordinationWorklistSuccessAtom = atom(
  null,
  (_get, set, { projectStateKey, worklist, updatedAt }: ApplyCoordinationWorklistSuccessInput) => {
    set(coordinationWorklistResourceFamily(projectStateKey), {
      value: worklist,
      error: null,
      pending: false,
      stale: false,
      updatedAt: updatedAt ?? Date.now(),
    });
  },
);

export const applyCoordinationWorklistFailureAtom = atom(
  null,
  (get, set, { projectStateKey, error }: ApplyCoordinationWorklistFailureInput) => {
    const current = get(coordinationWorklistResourceFamily(projectStateKey));
    set(coordinationWorklistResourceFamily(projectStateKey), {
      ...current,
      error,
      pending: false,
      stale: current.value !== null,
    });
  },
);

export const clearCoordinationWorklistResourceAtom = atom(
  null,
  (_get, set, projectStateKey: ProjectStateKey) => {
    set(coordinationWorklistResourceFamily(projectStateKey), emptyCoordinationWorklistResource());
  },
);

export function isCurrentCoordinationWorklistRequest(
  request: CoordinationWorklistRequestScope,
  current: CoordinationWorklistRequestScope,
): boolean {
  return (
    request.projectStateKey === current.projectStateKey &&
    request.endpointKey === current.endpointKey &&
    request.generation === current.generation
  );
}
