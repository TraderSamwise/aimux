import type { MachineInfo } from "./machines.js";
import type { SecurityEventRecord } from "./security.js";

export interface Env {
  RELAY: DurableObjectNamespace;
  ATTACHMENTS?: R2Bucket;
  // Secrets are configured via `wrangler secret put` at deploy time. They
  // may be unset in a dev/preview environment; callers must guard on
  // missing values rather than assume they're populated.
  CLERK_SECRET_KEY?: string;
  RELAY_TOKEN_SECRET?: string;
  // Comma-separated allowlist of web-app origins permitted to call the
  // token-issuing endpoint. When unset, /cli/issue-token rejects all
  // cross-origin requests outright.
  CLI_TOKEN_ALLOWED_ORIGINS?: string;
  // warn: record and notify about first-time devices but allow requests.
  // enforce: deny client requests until the device has been approved.
  SECURITY_DEVICE_POLICY?: "warn" | "enforce";
  // warn: record device proof metadata when clients support signing.
  // enforce: deny owner client connections without a valid device proof.
  SECURITY_DEVICE_PROOF_POLICY?: "warn" | "enforce";
  RESEND_API_KEY?: string;
  SECURITY_EMAIL_FROM?: string;
  SECURITY_ACTION_BASE_URL?: string;
  SECURITY_IP_HASH_SECRET?: string;
  COLLAB_EMAIL_FROM?: string;
  SHARE_INVITE_BASE_URL?: string;
  HOSTED_ATTACHMENT_BASE_URL?: string;
}

export interface RelayRequest {
  id: string;
  type: "request";
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  // Which machine should answer. Absent is a question, not a default: for a
  // person's client the relay resolves it only when there is exactly one
  // machine to mean, and for a daemon asking a peer it does not resolve it at
  // all -- a daemon is not somebody who can be asked which one it meant.
  machineId?: string;
}

export interface RelayProjectEventsSubscribe {
  id: string;
  type: "project_events_subscribe";
  path: string;
  headers?: Record<string, string>;
  machineId?: string;
}

export interface RelayProjectEventsUnsubscribe {
  id: string;
  type: "project_events_unsubscribe";
}

export interface RelayProjectEventsSubscribed {
  id: string;
  type: "project_events_subscribed";
}

export interface RelayProjectEvent {
  id: string;
  type: "project_event";
  event: string;
  data: unknown;
}

export interface RelayProjectEventsError {
  id: string;
  type: "project_events_error";
  status?: number;
  message: string;
  deviceId?: string;
  approvalCode?: string;
  machines?: MachineInfo[];
}

export interface RelayResponse {
  id: string;
  type: "response";
  status: number;
  /// Set to "relay" when the relay answered instead of the machine asked.
  ///
  /// A project service refuses with 502 and 503 as well, so an unmarked
  /// refusal leaves a daemon unable to tell "the peer's service is down" from
  /// "the relay would not carry this". A person's client ignores it; the
  /// field exists because a daemon has nobody to ask.
  source?: "relay";
  body?: unknown;
}

export interface MachineListPayload {
  machines: MachineInfo[];
}

export interface RelayControl {
  type: "ping" | "pong" | "connected" | "error" | "daemon_status";
  role?: "daemon" | "client";
  message?: string;
  // True when ANY machine is up. `machines` is the answer that replaces it:
  // "remote is up" became "which machines are up".
  online?: boolean;
  machines?: MachineInfo[];
}

export interface RelaySecurityEventControl {
  type: "security_event";
  event: SecurityEventRecord;
}

export interface RelayNotificationPushControl {
  type: "notification_push";
  notification: {
    title: string;
    body: string;
    kind?: string;
    sessionId?: string;
    projectId?: string;
    projectRoot?: string;
    dedupeKey?: string;
  };
}

/// Where a daemon's project services are listening right now.
///
/// A project service binds a fresh port on every start, and a share stores the
/// endpoint it was created with. Without this frame the first restart after a
/// share was made leaves that share proxying to a port nothing is on.
export interface RelayProjectEndpointsControl {
  type: "project_endpoints";
  projects: Array<{
    projectRoot: string;
    host: string;
    port: number;
  }>;
}

export type RelayMessage =
  | RelayRequest
  | RelayProjectEventsSubscribe
  | RelayProjectEventsUnsubscribe
  | RelayProjectEventsSubscribed
  | RelayProjectEvent
  | RelayProjectEventsError
  | RelayResponse
  | RelayControl
  | RelaySecurityEventControl
  | RelayNotificationPushControl
  | RelayProjectEndpointsControl;
