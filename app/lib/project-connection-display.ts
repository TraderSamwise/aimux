import type { AppConnectionMode } from "@/lib/connection-targets";
import type { DaemonProject } from "@/lib/api";
import type { ServiceEndpoint } from "@/lib/daemon-url";

export function getProjectServiceEndpoint(project: DaemonProject | null | undefined) {
  if (!project?.serviceAlive) return null;
  return project.serviceEndpoint;
}

export function formatProjectEndpointLabel(
  endpoint: ServiceEndpoint | null,
  connectionMode: AppConnectionMode,
): string {
  if (!endpoint) return "host offline";
  if (connectionMode === "relay") return "via relay";
  return `${endpoint.host}:${endpoint.port}`;
}

export function projectStateErrorCopy(error: string): {
  title: string;
  detail: string;
} {
  if (isProjectHostOfflineError(error)) {
    return {
      title: "Project host not running.",
      detail: "Start the host to see worktrees, agents, and services for this project.",
    };
  }
  if (/pending security approval/i.test(error)) {
    return {
      title: "Remote client pending approval.",
      detail: "Open Inbox and approve this device, then refresh project state.",
    };
  }
  if (/relay not connected/i.test(error)) {
    return {
      title: "Relay not connected.",
      detail: "Reconnect the remote session, then refresh project state.",
    };
  }
  return {
    title: "Could not load project state.",
    detail: error,
  };
}

export function isProjectHostOfflineError(error: string) {
  return /ECONNREFUSED|Failed to fetch|Network request failed|Load failed/i.test(error);
}
