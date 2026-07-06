import { atom } from "jotai";
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
  projectPath: string;
  library: LibraryValue;
  updatedAt?: number;
}

export interface ApplyLibraryFailureInput {
  projectPath: string;
  error: string;
}

export interface LibraryRequestScope {
  projectPath: string;
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

export const libraryResourceFamily = atomFamily((_projectPath: string) =>
  atom<LibraryResource>(emptyLibraryResource()),
);

export const libraryFamily = atomFamily((projectPath: string) =>
  atom((get) => get(libraryResourceFamily(projectPath)).value),
);

export const libraryErrorFamily = atomFamily((projectPath: string) =>
  atom((get) => get(libraryResourceFamily(projectPath)).error),
);

export const beginLibraryRefreshAtom = atom(null, (get, set, projectPath: string) => {
  const current = get(libraryResourceFamily(projectPath));
  set(libraryResourceFamily(projectPath), {
    ...current,
    pending: true,
    stale: current.value !== null,
  });
});

export const applyLibrarySuccessAtom = atom(
  null,
  (_get, set, { projectPath, library, updatedAt }: ApplyLibrarySuccessInput) => {
    set(libraryResourceFamily(projectPath), {
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
  (get, set, { projectPath, error }: ApplyLibraryFailureInput) => {
    const current = get(libraryResourceFamily(projectPath));
    set(libraryResourceFamily(projectPath), {
      ...current,
      error,
      pending: false,
      stale: current.value !== null,
    });
  },
);

export const clearLibraryResourceAtom = atom(null, (_get, set, projectPath: string) => {
  set(libraryResourceFamily(projectPath), emptyLibraryResource());
});

export function isCurrentLibraryRequest(
  request: LibraryRequestScope,
  current: LibraryRequestScope,
): boolean {
  return (
    request.projectPath === current.projectPath &&
    request.endpointKey === current.endpointKey &&
    request.generation === current.generation
  );
}
