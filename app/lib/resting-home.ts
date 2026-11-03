export interface ProjectRefLike {
  path?: string;
  machineId?: string;
}

export interface RestingHomeInput {
  /** The project the user last chose, if any. */
  selectedProject: ProjectRefLike | null | undefined;
  /** The share being viewed, if this route is a shared chat. */
  activeShare: { ownerUserId?: string; projectRoot?: string } | null | undefined;
  /** The signed-in user, to tell "my own project, shared out" from someone else's. */
  userId: string | null | undefined;
}

/**
 * Which project "home" is.
 *
 * One answer, because two surfaces ask. The Projects tab worked this out
 * inline, and when the logo became clickable the obvious move was to write the
 * same conditional next to it -- which is how the logo and the tab come to
 * disagree the moment either rule changes.
 *
 * Only the project is decided here, not the route. The tab switches tabs and
 * needs the group-qualified path; the logo is pressed from outside the tab
 * navigator and needs the public one. Same destination, two spellings, so the
 * spelling stays with each caller and only the choice of project is shared.
 *
 * A share names one host and carries no machine of its own, so a share the
 * user owns resolves to that project, and a share they do not falls back to
 * their own selection rather than following someone else's root.
 */
export function restingHomeTarget({
  selectedProject,
  activeShare,
  userId,
}: RestingHomeInput): ProjectRefLike | undefined {
  if (activeShare && userId && activeShare.ownerUserId === userId) {
    return { path: activeShare.projectRoot };
  }
  return selectedProject ?? undefined;
}

/**
 * The query the public `/project` route takes for a given home target.
 *
 * Empty when no project is chosen, which lands on the project list -- the
 * resting page when there is nothing selected to rest on.
 */
export function restingHomeParams(target: ProjectRefLike | undefined): {
  project?: string;
  machine?: string;
} {
  const project = target?.path?.trim();
  if (!project) return {};
  const machine = target?.machineId?.trim();
  return machine ? { project, machine } : { project };
}
