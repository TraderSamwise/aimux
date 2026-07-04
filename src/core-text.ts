import type { CoreRelaySnapshot, CoreStatusProject } from "./core-command-contract.js";

export interface CoreDaemonStatusTextPayload {
  daemon: { pid?: number; port?: number; serviceInfo?: unknown } | null;
  projects: Array<{ serviceAlive?: boolean }>;
  relay: CoreRelaySnapshot;
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
