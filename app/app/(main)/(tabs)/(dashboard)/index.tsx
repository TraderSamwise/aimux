import React from "react";
import { Redirect } from "expo-router";
import { useAtomValue } from "jotai";
import { selectedProjectPathAtom } from "@/stores/projects";
import { buildViewHref } from "@/lib/view-location";

// The worktree dashboard now lives as the default "Dashboard" section of the
// Project screen. The legacy standalone route redirects there so every landing
// path (default project, project switch, root URL) ends up in the same place.
export default function DashboardIndex() {
  const projectPath = useAtomValue(selectedProjectPathAtom);
  return <Redirect href={buildViewHref("/project", { project: projectPath ?? undefined })} />;
}
