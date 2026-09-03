export type RelayConnectionStatus = "connected" | "connecting" | "reconnecting" | "disconnected" | "auth_failed";

export interface RelayStatusSnapshot {
  status: RelayConnectionStatus;
  relayUrl: string;
  lastConnectedAt: string | null;
  lastError: string | null;
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
