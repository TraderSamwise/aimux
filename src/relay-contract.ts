export type RelayConnectionStatus = "connected" | "connecting" | "reconnecting" | "disconnected" | "auth_failed";

export interface RelayStatusSnapshot {
  status: RelayConnectionStatus;
  relayUrl: string;
  lastConnectedAt: string | null;
  lastError: string | null;
  /**
   * What happened to the LAST socket, as opposed to why we are not connected
   * right now. `lastError` is cleared by a connect, so on a link that
   * reconnects every second it was always null and every surface read
   * "connected" while the connection was collapsing. These survive the
   * reconnect.
   */
  lastDisconnectedAt: string | null;
  lastCloseCode: number | null;
  lastCloseReason: string | null;
  /** Connections in a row that did not outlive `shortConnectionThresholdMs`. */
  consecutiveShortConnections: number;
  /** Connected AND collapsing. `status` alone cannot say this. */
  flapping: boolean;
  shortConnectionThresholdMs: number;
}

export interface RelayNotificationPush {
  title: string;
  body: string;
  kind?: string;
  sessionId?: string;
  projectId?: string;
  notificationId?: string;
  projectName?: string;
  projectRoot?: string;
  worktreePath?: string;
  worktreeName?: string;
  branch?: string;
  categoryLabel?: string;
  reasonLabel?: string;
  dedupeKey?: string;
}
