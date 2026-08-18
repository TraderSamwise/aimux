import type { DaemonProject } from "@/lib/api";

export function hasKnownOnlineAgents(project: Pick<DaemonProject, "onlineAgentCount">): boolean {
  return project.onlineAgentCount === undefined || project.onlineAgentCount > 0;
}

export function filterProjectPickerProjects(
  projects: readonly DaemonProject[],
  options: { showAll: boolean },
): DaemonProject[] {
  if (options.showAll) return [...projects];
  return projects.filter(hasKnownOnlineAgents);
}
