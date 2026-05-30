import type { AppConnectionMode } from "@/lib/connection-targets";
import type { ServiceEndpoint } from "@/lib/daemon-url";

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
