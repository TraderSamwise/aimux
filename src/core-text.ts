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
