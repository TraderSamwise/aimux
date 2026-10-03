import { atom } from "jotai";
import type { ProjectStateKey } from "@/lib/project-key";
import { atomFamily } from "jotai/utils";
import type { LibraryDocument } from "@/lib/api";

export interface LibraryValue {
  documents: LibraryDocument[];
  fetchedAt: string;
}

export interface LibraryResource {
  value: LibraryValue | null;
  error: string | null;
  pending: boolean;
  stale: boolean;
  updatedAt: number | null;
}

export interface ApplyLibrarySuccessInput {
  projectStateKey: ProjectStateKey;
  library: LibraryValue;
  updatedAt?: number;
}

export interface ApplyLibraryFailureInput {
  projectStateKey: ProjectStateKey;
  error: string;
}

export interface LibraryRequestScope {
  projectStateKey: ProjectStateKey;
  endpointKey: string | null;
  generation: number;
}

const emptyLibraryResource = (): LibraryResource => ({
  value: null,
  error: null,
  pending: false,
  stale: false,
  updatedAt: null,
});

export const libraryResourceFamily = atomFamily((_projectStateKey: ProjectStateKey) =>
  atom<LibraryResource>(emptyLibraryResource()),
);

export const libraryFamily = atomFamily((projectStateKey: ProjectStateKey) =>
  atom((get) => get(libraryResourceFamily(projectStateKey)).value),
);

export const libraryErrorFamily = atomFamily((projectStateKey: ProjectStateKey) =>
  atom((get) => get(libraryResourceFamily(projectStateKey)).error),
);

export const beginLibraryRefreshAtom = atom(null, (get, set, projectStateKey: ProjectStateKey) => {
  const current = get(libraryResourceFamily(projectStateKey));
  set(libraryResourceFamily(projectStateKey), {
    ...current,
    pending: true,
    stale: current.value !== null,
  });
});

export const applyLibrarySuccessAtom = atom(
  null,
  (_get, set, { projectStateKey, library, updatedAt }: ApplyLibrarySuccessInput) => {
    set(libraryResourceFamily(projectStateKey), {
      value: library,
      error: null,
      pending: false,
      stale: false,
      updatedAt: updatedAt ?? Date.now(),
    });
  },
);

export const applyLibraryFailureAtom = atom(
  null,
  (get, set, { projectStateKey, error }: ApplyLibraryFailureInput) => {
    const current = get(libraryResourceFamily(projectStateKey));
    set(libraryResourceFamily(projectStateKey), {
      ...current,
      error,
      pending: false,
      stale: current.value !== null,
    });
  },
);

export const clearLibraryResourceAtom = atom(
  null,
  (_get, set, projectStateKey: ProjectStateKey) => {
    set(libraryResourceFamily(projectStateKey), emptyLibraryResource());
  },
);

export function isCurrentLibraryRequest(
  request: LibraryRequestScope,
  current: LibraryRequestScope,
): boolean {
  return (
    request.projectStateKey === current.projectStateKey &&
    request.endpointKey === current.endpointKey &&
    request.generation === current.generation
  );
}
