export type RelayConnectionStatus = "connected" | "connecting" | "reconnecting" | "disconnected" | "auth_failed";

export interface RelayStatusSnapshot {
  status: RelayConnectionStatus;
  relayUrl: string;
  lastConnectedAt: string | null;
  lastError: string | null;
}
