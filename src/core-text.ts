import type { CoreProjectServiceState, CoreRelaySnapshot, CoreStatusProject } from "./core-command-contract.js";

export interface CoreDaemonStatusTextPayload {
  daemon: { pid?: number; port?: number; serviceInfo?: unknown } | null;
  projects: Array<{ serviceAlive?: boolean }>;
  relay: CoreRelaySnapshot;
}

export interface CoreHostStatusTextPayload {
  projectRoot: string;
  sessionName: string | null;
  daemon: { serviceInfo?: unknown };
  projectService: unknown | null;
  serviceAlive: boolean;
  metadataEndpoint: unknown;
  expectedServiceManifest: unknown;
}

export interface CoreProjectEnsureTextPayload {
  project: CoreProjectServiceState;
}

export interface CoreRemoteStatusTextPayload {
  credentials: { relayUrl: string; remoteEnabled: boolean } | null;
  relay: CoreRelaySnapshot;
}

export interface CoreWhoamiTextPayload {
  credentials: { userId: string; relayUrl: string; remoteEnabled: boolean } | null;
}

export type CoreLogoutTextResult = "cleared" | "none" | "failed";

export interface CoreLoginTextPayload {
  userId: string;
  relay: CoreRelaySnapshot;
}

function coreProjectServicePid(projectService: unknown): number | null {
  return projectService &&
    typeof projectService === "object" &&
    typeof (projectService as { pid?: unknown }).pid === "number"
    ? (projectService as { pid: number }).pid
    : null;
}

export function renderCoreDaemonStatusLines(payload: CoreDaemonStatusTextPayload): string[] {
  const daemon = payload.daemon;
  if (!daemon) return ["aimux daemon is not running."];
  const lines = [`Daemon pid=${daemon.pid} port=${daemon.port}`];
  lines.push(`Known projects: ${payload.projects.length}`);
  lines.push(`Live project services: ${payload.projects.filter((project) => project.serviceAlive).length}`);
  const relay = payload.relay;
  if (relay.status && relay.status !== "off") {
    lines.push(`Relay: ${relay.status}${relay.relayUrl ? ` (${relay.relayUrl})` : ""}`);
  } else {
    lines.push("Relay: off");
  }
  return lines;
}

export function renderCoreHostStatusLines(payload: CoreHostStatusTextPayload, knownProject: boolean): string[] {
  if (!knownProject) return [`No known control service for ${payload.projectRoot}`];
  const lines = [`Service: ${payload.serviceAlive ? "live" : "idle"}`];
  const pid = coreProjectServicePid(payload.projectService);
  if (pid !== null) lines.push(`Service pid=${pid}`);
  lines.push(`Metadata: ${payload.metadataEndpoint ? JSON.stringify(payload.metadataEndpoint) : "not running"}`);
  lines.push(`Expected manifest: ${JSON.stringify(payload.expectedServiceManifest)}`);
  lines.push(`Tmux session: ${payload.sessionName}`);
  return lines;
}

export function renderCoreProjectEnsureLines(payload: CoreProjectEnsureTextPayload): string[] {
  return [`Ensured project service for ${payload.project.projectRoot} (pid ${payload.project.pid})`];
}

export function renderCoreDaemonProjectsLines(projects: CoreStatusProject[]): string[] {
  return projects.map((project) => {
    const badge = project.serviceAlive ? "service" : "idle";
    return `${project.name}  ${badge}  ${project.path}`;
  });
}

export function renderCoreProjectsListLines(projects: CoreStatusProject[]): string[] {
  if (projects.length === 0) return ["No aimux projects found."];
  return projects.map((project) => {
    const liveBadge = project.serviceAlive ? "live" : "idle";
    return `${project.name}  ${liveBadge}  ${project.path}`;
  });
}

function relayLastError(relay: CoreRelaySnapshot): string | null {
  return "lastError" in relay ? relay.lastError : null;
}

export function renderCoreRemoteStatusLines(payload: CoreRemoteStatusTextPayload): string[] {
  const { credentials, relay } = payload;
  if (!credentials) return ["Not logged in. Run `aimux login` to enable remote access."];
  const lines = [
    `Remote access: ${credentials.remoteEnabled ? "enabled" : "disabled"}`,
    `Relay: ${credentials.relayUrl}`,
    `Connection: ${relay.status ?? "unknown"}`,
  ];
  const lastError = relayLastError(relay);
  if (lastError) lines.push(`Last error: ${lastError}`);
  return lines;
}

export function renderCoreRemoteEnableLines(relay: CoreRelaySnapshot): string[] {
  return [`✓ Remote access enabled (connection: ${relay.status ?? "unknown"})`];
}

export function renderCoreRemoteDisableLines(daemonDisconnected: boolean): string[] {
  return [
    daemonDisconnected ? "✓ Remote access disabled. Daemon disconnected from relay." : "✓ Remote access disabled.",
  ];
}

export function renderCoreWhoamiLines(payload: CoreWhoamiTextPayload): string[] {
  const credentials = payload.credentials;
  if (!credentials) return ["Not logged in. Run `aimux login` to enable remote access."];
  return [
    `Logged in as ${credentials.userId}`,
    `Relay: ${credentials.relayUrl}`,
    `Remote access: ${credentials.remoteEnabled ? "enabled" : "disabled"}`,
  ];
}

export function coreWhoamiJson(
  payload: CoreWhoamiTextPayload,
): { loggedIn: true; userId: string; relayUrl: string; remoteEnabled: boolean } | { loggedIn: false } {
  const credentials = payload.credentials;
  return credentials
    ? {
        loggedIn: true,
        userId: credentials.userId,
        relayUrl: credentials.relayUrl,
        remoteEnabled: credentials.remoteEnabled,
      }
    : { loggedIn: false };
}

export function renderCoreLogoutLines(result: CoreLogoutTextResult): string[] {
  if (result === "cleared") return ["✓ Logged out. Remote access disabled."];
  if (result === "none") return ["Not logged in."];
  return ["Failed to remove credentials file — check permissions."];
}

export function renderCoreLoginLines(payload: CoreLoginTextPayload): string[] {
  return ["", `✓ Logged in as ${payload.userId}`, ...renderRelayAuthLines(payload.relay)];
}

export function renderCoreSecurityUnlockLines(payload: CoreLoginTextPayload): string[] {
  return ["", `✓ Security unlocked for ${payload.userId}`, ...renderRelayAuthLines(payload.relay)];
}

function renderRelayAuthLines(relay: CoreRelaySnapshot): string[] {
  const status = relay.status ?? "unknown";
  const lines =
    status === "off"
      ? ["Remote access is enabled. The daemon will connect on next start."]
      : status === "connected" || status === "connecting" || status === "reconnecting"
        ? [`Remote access is enabled (connection: ${status}).`]
        : [`Remote access credentials were saved, but relay is ${status}.`];
  const lastError = relayLastError(relay);
  if (lastError) lines.push(`Last error: ${lastError}`);
  return lines;
}
