import type { SecurityEventRecord } from "./security.js";

export interface Env {
  RELAY: DurableObjectNamespace;
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
  RESEND_API_KEY?: string;
  SECURITY_EMAIL_FROM?: string;
  SECURITY_ACTION_BASE_URL?: string;
  SECURITY_IP_HASH_SECRET?: string;
  COLLAB_EMAIL_FROM?: string;
  SHARE_INVITE_BASE_URL?: string;
}

export interface RelayRequest {
  id: string;
  type: "request";
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface RelayResponse {
  id: string;
  type: "response";
  status: number;
  body?: unknown;
}

export interface RelayControl {
  type: "ping" | "pong" | "connected" | "error" | "daemon_status";
  role?: "daemon" | "client";
  message?: string;
  online?: boolean;
}

export interface RelaySecurityEventControl {
  type: "security_event";
  event: SecurityEventRecord;
}

export type RelayMessage = RelayRequest | RelayResponse | RelayControl | RelaySecurityEventControl;
