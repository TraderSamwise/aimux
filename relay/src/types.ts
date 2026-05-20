export interface Env {
  RELAY: DurableObjectNamespace;
  CLERK_SECRET_KEY: string;
}

export interface RelayRequest {
  id: string;
  type: "request";
  method: string;
  path: string;
  body?: unknown;
}

export interface RelayResponse {
  id: string;
  type: "response";
  status: number;
  body: unknown;
}

export interface RelayControl {
  type: "ping" | "pong" | "connected" | "error" | "daemon_status";
  role?: "daemon" | "client";
  message?: string;
  online?: boolean;
}

export type RelayMessage = RelayRequest | RelayResponse | RelayControl;
