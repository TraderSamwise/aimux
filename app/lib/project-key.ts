// What identifies a project.
//
// A path is not an identity. `~/cs/aimux` exists on both of Sam's MacBooks, and
// `compute_project_id` is the basename plus a hash of the absolute path, so the
// two machines produce the same id as well. Anything that keys a project --
// selection, a cache, a route, a storage entry -- keys on the pair.

// NUL cannot appear in a POSIX path, so the two halves can always be told
// apart. The key is internal: a URL carries the machine as its own parameter.
const SEPARATOR = "\u0000";

export interface ProjectRef {
  // Absent in local mode and on a shared surface, where there is only ever one
  // host to mean.
  machineId?: string;
  path: string;
}

export function projectKey(ref: ProjectRef | null | undefined): string | null {
  if (!ref?.path) return null;
  return `${ref.machineId ?? ""}${SEPARATOR}${ref.path}`;
}

export function projectRefOf(
  project: { machineId?: string; path: string } | null | undefined,
): ProjectRef | null {
  if (!project?.path) return null;
  return project.machineId
    ? { machineId: project.machineId, path: project.path }
    : { path: project.path };
}

export function sameProjectRef(
  left: ProjectRef | null | undefined,
  right: ProjectRef | null | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (left.machineId ?? "") === (right.machineId ?? "") && left.path === right.path;
}

// A ref with no machine matches a project with no machine, and nothing else.
// Falling back to a path match would hand back the wrong machine's project,
// which is the whole failure this module exists to stop.
export function findProjectByRef<T extends { machineId?: string; path: string }>(
  projects: readonly T[],
  ref: ProjectRef | null | undefined,
): T | undefined {
  if (!ref) return undefined;
  return projects.find((project) => sameProjectRef(projectRefOf(project), ref));
}

// Round-trips through storage, where a ref is held as a string.
export function parseProjectKey(key: string | null | undefined): ProjectRef | null {
  if (!key) return null;
  const separator = key.indexOf(SEPARATOR);
  // A bare path is what an older build persisted, from before machines
  // existed. It is a ref with no machine, which is exactly what it meant.
  if (separator < 0) return key ? { path: key } : null;
  const machineId = key.slice(0, separator);
  const path = key.slice(separator + SEPARATOR.length);
  if (!path) return null;
  return machineId ? { machineId, path } : { path };
}

// For input that names a path and no machine -- a push payload, a stored
// selection from before machines existed. One machine with that path is an
// answer; two is a question, and `null` lets the caller refuse rather than
// open whichever host came first in the list.
export function uniqueProjectRefForPath<T extends { machineId?: string; path: string }>(
  projects: readonly T[],
  path: string | null | undefined,
): ProjectRef | null {
  if (!path) return null;
  const matches = projects.filter((project) => project.path === path);
  return matches.length === 1 ? projectRefOf(matches[0]) : null;
}

// The one rule for turning a ref into a project, used by the selection store,
// the route hook and the layout alike -- three surfaces that answered this
// question separately would disagree the moment a path existed twice.
//
// An exact match first. A ref with no machine -- an older stored selection, or
// a URL written before machines existed -- then resolves by path, but only
// when one machine has it.
export function findProjectForRef<T extends { machineId?: string; path: string }>(
  projects: readonly T[],
  ref: ProjectRef | null | undefined,
): T | undefined {
  if (!ref) return undefined;
  const exact = findProjectByRef(projects, ref);
  if (exact || ref.machineId) return exact;
  const matches = projects.filter((project) => project.path === ref.path);
  return matches.length === 1 ? matches[0] : undefined;
}

// A URL that names a path and no machine, beside a selection that names the
// same path on a known host: the selection is the more complete answer, and
// the URL is rewritten from it rather than overriding it.
export function preferMachineBearingRef(
  urlRef: ProjectRef | null | undefined,
  selectedRef: ProjectRef | null | undefined,
): ProjectRef | null {
  if (!urlRef) return selectedRef ?? null;
  if (!urlRef.machineId && selectedRef?.machineId && selectedRef.path === urlRef.path) {
    return selectedRef;
  }
  return urlRef;
}

// A ref from a payload the app did not write -- a push notification. The
// machine is used when it is there, and a bare path still resolves when one
// machine has it, so a notification sent before the relay stamped machines
// still opens the right project.
export function projectRefFromPayload<T extends { machineId?: string; path: string }>(
  projects: readonly T[],
  path: string | null | undefined,
  machineId: string | null | undefined,
): ProjectRef | null {
  if (!path) return null;
  const named = machineId?.trim();
  if (named) return { machineId: named, path };
  return uniqueProjectRefForPath(projects, path);
}
