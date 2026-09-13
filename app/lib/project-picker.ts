import type { DaemonProject } from "@/lib/api";

export function hasLiveProjectService(project: Pick<DaemonProject, "serviceAlive">): boolean {
  return project.serviceAlive;
}

export function filterProjectPickerProjects(
  projects: readonly DaemonProject[],
  options: { showAll: boolean },
): DaemonProject[] {
  if (options.showAll) return [...projects];
  return projects.filter(hasLiveProjectService);
}
