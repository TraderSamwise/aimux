import { useMemo } from "react";
import { useGlobalSearchParams } from "expo-router";
import { useAtomValue } from "jotai";
import type { DaemonProject } from "@/lib/api";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import { getProjectServiceEndpoint } from "@/lib/project-connection-display";
import { projectPathFromSearchOrLocation } from "@/lib/view-location";
import { projectsAtom, selectedProjectAtom } from "@/stores/projects";

export interface RouteProject {
  project: DaemonProject | null;
  projectPath: string | null;
  endpoint: ServiceEndpoint | null;
  routeProjectPath: string | null;
}

export function useRouteProject(): RouteProject {
  const searchParams = useGlobalSearchParams<{ project?: string | string[] }>();
  const projects = useAtomValue(projectsAtom);
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

  return {
    project,
    projectPath: routeProjectPath ?? project?.path ?? null,
    endpoint: getProjectServiceEndpoint(project),
    routeProjectPath,
  };
}
