import type { RelayStatus } from "@/lib/relay-transport";

export type InitialMainRoute = "project" | "shared";

export interface InitialMainRouteInput {
  isSignedIn: boolean;
  realSharedChatCount: number;
  activeProjectCount: number;
  projectDiscoverySynced: boolean;
  relayConfigured: boolean;
  relayStatus: RelayStatus;
}

export function initialMainRoute(input: InitialMainRouteInput): InitialMainRoute {
  if (!input.isSignedIn || input.realSharedChatCount <= 0) return "project";

  const cliUnavailable = input.relayConfigured && input.relayStatus !== "connected";
  const noActiveProjects = input.projectDiscoverySynced && input.activeProjectCount === 0;

  return cliUnavailable || noActiveProjects ? "shared" : "project";
}
