import { useMemo } from "react";
import { useGlobalSearchParams } from "expo-router";
import { useAtomValue } from "jotai";
import type { DaemonProject } from "@/lib/api";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import {
  getProjectServiceEndpoint,
  isRelayUnavailableForProjectDiscovery,
} from "@/lib/project-connection-display";
import { useRouteShare } from "@/lib/use-route-share";
import { findProjectForRef, projectRefOf, type ProjectRef } from "@/lib/project-key";
import { projectRefFromSearchOrLocation } from "@/lib/view-location";
import { lastSyncAtAtom, projectsAtom, selectedProjectAtom } from "@/stores/projects";
import { relayConfiguredAtom, relayStatusAtom } from "@/stores/relay";
import type { ActiveSharedSession } from "@/stores/settings";

export interface RouteProject {
  project: DaemonProject | null;
  projectPath: string | null;
  // Which machine's copy. `null` in local mode and on a shared surface.
  machineId: string | null;
  projectRef: ProjectRef | null;
  endpoint: ServiceEndpoint | null;
  routeProjectPath: string | null;
  projectLoading: boolean;
}

export function useRouteProject(): RouteProject {
  const searchParams = useGlobalSearchParams<{
    project?: string | string[];
    machine?: string | string[];
  }>();
  const projects = useAtomValue(projectsAtom);
  const lastSyncAt = useAtomValue(lastSyncAtAtom);
  const selectedProject = useAtomValue(selectedProjectAtom);
  const activeShare = useRouteShare();
  const relayConfigured = useAtomValue(relayConfiguredAtom);
  const relayStatus = useAtomValue(relayStatusAtom);
  const routeRef = projectRefFromSearchOrLocation(searchParams.project, searchParams.machine);
  const routeProjectPath = routeRef?.path ?? null;
  const sharedRouteProject = useMemo(
    () =>
      activeShare && (!routeProjectPath || routeProjectPath === activeShare.projectRoot)
        ? projectFromActiveShare(activeShare)
        : null,
    [activeShare, routeProjectPath],
  );
  const routeMachineId = routeRef?.machineId ?? null;
  const routeProject = useMemo(
    () =>
      routeProjectPath
        ? routeProjectPath === sharedRouteProject?.path
          ? // A share has one host and no machine of its own, so it is matched
            // by path as it always was.
            sharedRouteProject
          : (findProjectForRef(
              projects,
              routeMachineId
                ? { machineId: routeMachineId, path: routeProjectPath }
                : { path: routeProjectPath },
            ) ?? null)
        : null,
    [projects, routeMachineId, routeProjectPath, sharedRouteProject],
  );
  const project = routeProjectPath ? routeProject : (sharedRouteProject ?? selectedProject);
  const relayUnavailable =
    !activeShare && relayConfigured && isRelayUnavailableForProjectDiscovery(relayStatus);
  const projectLoading = Boolean(
    routeProjectPath && !routeProject && !lastSyncAt && !relayUnavailable,
  );
  const routeEndpoint = getProjectServiceEndpoint(project);
  const endpointHost = routeEndpoint?.host ?? null;
  const endpointPort = routeEndpoint?.port ?? null;
  // Rebuilt from primitives so the object identity is stable across polls.
  // The machine is one of those primitives: dropping it here would send every
  // project call to whichever host the relay guessed.
  const endpointMachineId = routeEndpoint?.machineId ?? null;
  const endpoint = useMemo<ServiceEndpoint | null>(
    () =>
      endpointHost !== null && endpointPort !== null
        ? {
            host: endpointHost,
            port: endpointPort,
            ...(endpointMachineId ? { machineId: endpointMachineId } : {}),
          }
        : null,
    [endpointHost, endpointMachineId, endpointPort],
  );

  const projectRef = projectRefOf(project);
  const projectRefKey = projectRef ? `${projectRef.machineId ?? ""}:${projectRef.path}` : null;
  return useMemo(
    () => ({
      project,
      projectPath: routeProjectPath ?? project?.path ?? null,
      machineId: project?.machineId ?? routeMachineId,
      projectRef,
      endpoint,
      routeProjectPath,
      projectLoading,
    }),
    // projectRefKey stands in for projectRef, whose identity is fresh each
    // render; the ref itself is stable in content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [endpoint, project, projectLoading, projectRefKey, routeMachineId, routeProjectPath],
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
    // A shared session is reachable and has no local dashboard to sample, so it
    // must not read as offline in the picker.
    dashboardAlive: true,
    serviceEndpoint: activeShare.serviceEndpoint,
  };
}
