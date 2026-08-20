import type { AppConnectionMode } from "@/lib/connection-targets";
import type { DaemonProject } from "@/lib/api";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import type { RelayStatus } from "@/lib/relay-transport";

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
    const approvalCode = error
      .match(/\bCode\s+([2-9A-HJ-NP-Z]{3}-[2-9A-HJ-NP-Z]{3})\b/i)?.[1]
      ?.toUpperCase();
    return {
      title: "Remote client pending approval.",
      detail: approvalCode
        ? `Run \`aimux security device approve\`, match code ${approvalCode}, then refresh project state.`
        : "Run `aimux security device approve`, match the code, then refresh project state.",
    };
  }
  if (/relay not connected/i.test(error)) {
    return {
      title: "Remote unavailable.",
      detail: "Aimux could not reach the remote control plane. Try again after it reconnects.",
    };
  }
  return {
    title: "Could not load project state.",
    detail: error,
  };
}

export function isDevicePendingApprovalError(error: string): boolean {
  return /pending security approval/i.test(error);
}

export function isProjectHostOfflineError(error: string) {
  return /ECONNREFUSED|Failed to fetch|Network request failed|Load failed/i.test(error);
}

export function isRelayUnavailableForProjectDiscovery(status: RelayStatus): boolean {
  return (
    status === "device_pending" ||
    status === "daemon_offline" ||
    status === "relay_unavailable" ||
    status === "auth_failed"
  );
}

export function relayUnavailableProjectCopy(status: RelayStatus): {
  title: string;
  detail: string;
} {
  if (status === "device_pending") {
    return {
      title: "Remote approval required.",
      detail: "Run `aimux security device approve`, match the code, then refresh.",
    };
  }
  if (status === "daemon_offline") {
    return {
      title: "Host offline.",
      detail: "Start the Aimux host to see projects and sessions.",
    };
  }
  if (status === "auth_failed") {
    return {
      title: "Remote access blocked.",
      detail: "Open Inbox and approve this device, then refresh.",
    };
  }
  return {
    title: "Remote unavailable.",
    detail: "Aimux could not reach the remote control plane. Try again after it reconnects.",
  };
}
