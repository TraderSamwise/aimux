import { useMemo } from "react";
import { useGlobalSearchParams } from "expo-router";
import { useAtomValue } from "jotai";
import type { DaemonProject } from "@/lib/api";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import { getProjectServiceEndpoint } from "@/lib/project-connection-display";
import { useRouteShare } from "@/lib/use-route-share";
import { projectPathFromSearchOrLocation } from "@/lib/view-location";
import { lastSyncAtAtom, projectsAtom, selectedProjectAtom } from "@/stores/projects";
import type { ActiveSharedSession } from "@/stores/settings";

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
  const activeShare = useRouteShare();
  const routeProjectPath = projectPathFromSearchOrLocation(searchParams.project);
  const sharedRouteProject = useMemo(
    () =>
      activeShare && (!routeProjectPath || routeProjectPath === activeShare.projectRoot)
        ? projectFromActiveShare(activeShare)
        : null,
    [activeShare, routeProjectPath],
  );
  const routeProject = useMemo(
    () =>
      routeProjectPath
        ? routeProjectPath === sharedRouteProject?.path
          ? sharedRouteProject
          : (projects.find((project) => project.path === routeProjectPath) ?? null)
        : null,
    [projects, routeProjectPath, sharedRouteProject],
  );
  const project = routeProjectPath ? routeProject : (sharedRouteProject ?? selectedProject);
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

function projectFromActiveShare(activeShare: ActiveSharedSession): DaemonProject {
  const name = activeShare.projectRoot.split("/").filter(Boolean).pop() || "shared project";
  return {
    id: `shared:${activeShare.shareId}`,
    name,
    path: activeShare.projectRoot,
    lastSeen: activeShare.acceptedAt,
    dashboardSessionName: `shared:${activeShare.shareId}`,
    service: null,
    serviceAlive: true,
    serviceEndpoint: activeShare.serviceEndpoint,
  };
}
