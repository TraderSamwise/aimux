import React from "react";
import { ActivityIndicator, View } from "react-native";
import { Redirect, useGlobalSearchParams } from "expo-router";
import { useAtomValue } from "jotai";
import {
  initialMainRoute,
  ownBackendSignal,
  useLandingWaitExpired,
} from "@/lib/initial-main-route";
import { useAuth } from "@/lib/auth";
import { selectedProjectRefAtom } from "@/stores/projects";
import { relayConfiguredAtom, relayMachinesAtom, relayStatusAtom } from "@/stores/relay";
import { buildViewHref, projectRefFromSearchOrLocation } from "@/lib/view-location";
import { acceptedSharedSessionsAtom, settingsHydratedAtom } from "@/stores/settings";

// The worktree dashboard now lives as the default "Dashboard" section of the
// Project screen. The legacy standalone route redirects there so every landing
// path (default project, project switch, root URL) ends up in the same place.
export default function DashboardIndex() {
  const searchParams = useGlobalSearchParams<{
    project?: string | string[];
    machine?: string | string[];
  }>();
  const { isSignedIn } = useAuth();
  const selectedProjectRef = useAtomValue(selectedProjectRefAtom);
  const relayConfigured = useAtomValue(relayConfiguredAtom);
  const relayStatus = useAtomValue(relayStatusAtom);
  const relayMachines = useAtomValue(relayMachinesAtom);
  const acceptedShares = useAtomValue(acceptedSharedSessionsAtom);
  const sharesHydrated = useAtomValue(settingsHydratedAtom);
  const waitExpired = useLandingWaitExpired();
  const projectRef =
    projectRefFromSearchOrLocation(searchParams.project, searchParams.machine) ??
    selectedProjectRef;
  const projectPath = projectRef?.path ?? null;

  const route = initialMainRoute({
    isSignedIn,
    ownBackend: ownBackendSignal(relayConfigured, relayStatus, relayMachines.length),
    realSharedChatCount: acceptedShares.length,
    sharesHydrated,
    waitExpired,
  });

  // An explicit project in the URL is the user's own answer, so it skips the
  // wait entirely -- there is nothing a relay could say that would change it.
  if (!projectPath && route === "pending") {
    return (
      <View className="flex-1 items-center justify-center bg-background p-6">
        <ActivityIndicator />
      </View>
    );
  }

  if (!projectPath && route === "shared") {
    return <Redirect href="/shares" />;
  }

  return (
    <Redirect
      href={buildViewHref("/project", {
        project: projectPath ?? undefined,
        machine: projectRef?.machineId,
      })}
    />
  );
}
