import { atom } from "jotai";
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
  projectPath: string;
  worklist: CoordinationWorklistValue;
  updatedAt?: number;
}

export interface ApplyCoordinationWorklistFailureInput {
  projectPath: string;
  error: string;
}

export interface CoordinationWorklistRequestScope {
  projectPath: string;
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

export const coordinationWorklistResourceFamily = atomFamily((_projectPath: string) =>
  atom<CoordinationWorklistResource>(emptyCoordinationWorklistResource()),
);

export const coordinationWorklistFamily = atomFamily((projectPath: string) =>
  atom((get) => get(coordinationWorklistResourceFamily(projectPath)).value),
);

export const coordinationWorklistErrorFamily = atomFamily((projectPath: string) =>
  atom((get) => get(coordinationWorklistResourceFamily(projectPath)).error),
);

export const beginCoordinationWorklistRefreshAtom = atom(null, (get, set, projectPath: string) => {
  const current = get(coordinationWorklistResourceFamily(projectPath));
  set(coordinationWorklistResourceFamily(projectPath), {
    ...current,
    pending: true,
    stale: current.value !== null,
  });
});

export const applyCoordinationWorklistSuccessAtom = atom(
  null,
  (_get, set, { projectPath, worklist, updatedAt }: ApplyCoordinationWorklistSuccessInput) => {
    set(coordinationWorklistResourceFamily(projectPath), {
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
  (get, set, { projectPath, error }: ApplyCoordinationWorklistFailureInput) => {
    const current = get(coordinationWorklistResourceFamily(projectPath));
    set(coordinationWorklistResourceFamily(projectPath), {
      ...current,
      error,
      pending: false,
      stale: current.value !== null,
    });
  },
);

export const clearCoordinationWorklistResourceAtom = atom(
  null,
  (_get, set, projectPath: string) => {
    set(coordinationWorklistResourceFamily(projectPath), emptyCoordinationWorklistResource());
  },
);

export function isCurrentCoordinationWorklistRequest(
  request: CoordinationWorklistRequestScope,
  current: CoordinationWorklistRequestScope,
): boolean {
  return (
    request.projectPath === current.projectPath &&
    request.endpointKey === current.endpointKey &&
    request.generation === current.generation
  );
}
