import React from "react";
import { Redirect, useGlobalSearchParams } from "expo-router";
import { useAtomValue } from "jotai";
import { selectedProjectPathAtom } from "@/stores/projects";
import { buildViewHref, projectPathFromSearchOrLocation } from "@/lib/view-location";
import { acceptedSharedSessionsAtom } from "@/stores/settings";

// The worktree dashboard now lives as the default "Dashboard" section of the
// Project screen. The legacy standalone route redirects there so every landing
// path (default project, project switch, root URL) ends up in the same place.
export default function DashboardIndex() {
  const searchParams = useGlobalSearchParams<{ project?: string | string[] }>();
  const selectedProjectPath = useAtomValue(selectedProjectPathAtom);
  const acceptedShares = useAtomValue(acceptedSharedSessionsAtom);
  const routeProjectPath = projectPathFromSearchOrLocation(searchParams.project);
  const projectPath = routeProjectPath ?? selectedProjectPath;

  if (!projectPath && acceptedShares.length > 0) {
    return <Redirect href="/shares" />;
  }

  return <Redirect href={buildViewHref("/project", { project: projectPath ?? undefined })} />;
}
