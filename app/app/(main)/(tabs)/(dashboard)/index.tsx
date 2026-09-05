import React from "react";
import { Redirect, useGlobalSearchParams } from "expo-router";
import { useAtomValue } from "jotai";
import { initialMainRoute } from "@/lib/initial-main-route";
import { useAuth } from "@/lib/auth";
import { lastSyncAtAtom, projectsAtom, selectedProjectPathAtom } from "@/stores/projects";
import { relayConfiguredAtom, relayStatusAtom } from "@/stores/relay";
import { buildViewHref, projectPathFromSearchOrLocation } from "@/lib/view-location";
import { acceptedSharedSessionsAtom } from "@/stores/settings";

// The worktree dashboard now lives as the default "Dashboard" section of the
// Project screen. The legacy standalone route redirects there so every landing
// path (default project, project switch, root URL) ends up in the same place.
export default function DashboardIndex() {
  const searchParams = useGlobalSearchParams<{ project?: string | string[] }>();
  const { isSignedIn } = useAuth();
  const projects = useAtomValue(projectsAtom);
  const selectedProjectPath = useAtomValue(selectedProjectPathAtom);
  const lastSyncAt = useAtomValue(lastSyncAtAtom);
  const relayConfigured = useAtomValue(relayConfiguredAtom);
  const relayStatus = useAtomValue(relayStatusAtom);
  const acceptedShares = useAtomValue(acceptedSharedSessionsAtom);
  const routeProjectPath = projectPathFromSearchOrLocation(searchParams.project);
  const projectPath = routeProjectPath ?? selectedProjectPath;
  const activeProjectCount = projects.filter((project) => project.serviceAlive).length;

  if (
    !projectPath &&
    initialMainRoute({
      isSignedIn,
      realSharedChatCount: acceptedShares.length,
      activeProjectCount,
      projectDiscoverySynced: lastSyncAt !== null,
      relayConfigured,
      relayStatus,
    }) === "shared"
  ) {
    return <Redirect href="/shares" />;
  }

  return <Redirect href={buildViewHref("/project", { project: projectPath ?? undefined })} />;
}
