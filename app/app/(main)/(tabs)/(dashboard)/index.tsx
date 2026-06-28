import React from "react";
import { Redirect, useGlobalSearchParams } from "expo-router";
import { useAtomValue } from "jotai";
import { selectedProjectPathAtom } from "@/stores/projects";
import { buildViewHref, projectPathFromSearchOrLocation } from "@/lib/view-location";

// The worktree dashboard now lives as the default "Dashboard" section of the
// Project screen. The legacy standalone route redirects there so every landing
// path (default project, project switch, root URL) ends up in the same place.
export default function DashboardIndex() {
  const searchParams = useGlobalSearchParams<{ project?: string | string[] }>();
  const selectedProjectPath = useAtomValue(selectedProjectPathAtom);
  const routeProjectPath = projectPathFromSearchOrLocation(searchParams.project);
  const projectPath = routeProjectPath ?? selectedProjectPath;

  return <Redirect href={buildViewHref("/project", { project: projectPath ?? undefined })} />;
}
