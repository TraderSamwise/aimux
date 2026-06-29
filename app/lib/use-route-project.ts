import { useMemo } from "react";
import { useGlobalSearchParams } from "expo-router";
import { useAtomValue } from "jotai";
import type { DaemonProject } from "@/lib/api";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import { getProjectServiceEndpoint } from "@/lib/project-connection-display";
import { projectPathFromSearchOrLocation } from "@/lib/view-location";
import { lastSyncAtAtom, projectsAtom, selectedProjectAtom } from "@/stores/projects";

export interface RouteProject {
  project: DaemonProject | null;
  projectPath: string | null;
  endpoint: ServiceEndpoint | null;
  routeProjectPath: string | null;
  projectLoading: boolean;
}

export function useRouteProject(): RouteProject {
  const searchParams = useGlobalSearchParams<{ project?: string | string[] }>();
  const projects = useAtomValue(projectsAtom);
  const lastSyncAt = useAtomValue(lastSyncAtAtom);
  const selectedProject = useAtomValue(selectedProjectAtom);
  const routeProjectPath = projectPathFromSearchOrLocation(searchParams.project);
  const routeProject = useMemo(
    () =>
      routeProjectPath
        ? (projects.find((project) => project.path === routeProjectPath) ?? null)
        : null,
    [projects, routeProjectPath],
  );
  const project = routeProjectPath ? routeProject : selectedProject;
  const projectLoading = Boolean(routeProjectPath && !routeProject && !lastSyncAt);
  const endpoint = useMemo(() => getProjectServiceEndpoint(project), [project]);

  return useMemo(
    () => ({
      project,
      projectPath: routeProjectPath ?? project?.path ?? null,
      endpoint,
      routeProjectPath,
      projectLoading,
    }),
    [endpoint, project, projectLoading, routeProjectPath],
  );
}
