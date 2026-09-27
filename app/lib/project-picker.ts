import type { DaemonProject } from "@/lib/api";

// A project is online when a tmux dashboard is running on it. This read
// `serviceAlive` -- the project-service process -- which is a different fact that
// only happened to agree.
export function isProjectOnline(project: Pick<DaemonProject, "dashboardAlive">): boolean {
  return project.dashboardAlive === true;
}

// Unknown is not offline: a daemon that could not ask tmux, or one predating the
// field, must not empty the picker. Only a definite "no dashboard" is hidden.
export function filterProjectPickerProjects(
  projects: readonly DaemonProject[],
  options: { showAll: boolean },
): DaemonProject[] {
  if (options.showAll) return [...projects];
  return projects.filter((project) => project.dashboardAlive !== false);
}

export type ProjectOnlineState = "online" | "offline" | "unknown";

// Three states, because there are three answers. Folding unknown into offline is
// how a failed tmux sample, or a daemon predating the field, would tell Sam every
// project is dead.
export function projectOnlineState(
  project: Pick<DaemonProject, "dashboardAlive">,
): ProjectOnlineState {
  if (project.dashboardAlive === true) return "online";
  if (project.dashboardAlive === false) return "offline";
  return "unknown";
}
