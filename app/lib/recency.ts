import type { DesktopService, DesktopSession } from "@/lib/desktop-state";

export function parseRecencyTimestamp(value?: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatRelativeRecency(value?: string | null, now = Date.now()): string | null {
  const timestamp = parseRecencyTimestamp(value);
  if (timestamp == null) return null;
  const deltaSeconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (deltaSeconds < 15) return "just now";
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  const minutes = Math.floor(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

export function formatLabeledRecency(
  label?: string | null,
  value?: string | null,
  now = Date.now(),
): string | null {
  const relative = formatRelativeRecency(value, now);
  if (!relative) return null;
  return label ? `${label} ${relative}` : relative;
}

function pendingActionRecencyLabel(value?: string | null): string | null {
  return value ? value.replace(/_/g, " ") : null;
}

export function formatSessionRecency(session: DesktopSession, now = Date.now()): string | null {
  if (session.recencyAt) return formatLabeledRecency(session.recencyLabel, session.recencyAt, now);

  const lastOutputAt = session.lastOutputAt;
  const output = lastOutputAt ? ({ label: "output", value: lastOutputAt } as const) : null;
  const semanticLabel = session.semantic?.user?.label;
  const latestUnreadAt = session.semantic?.notifications?.latestUnread?.createdAt;

  let anchor: { label: string; value?: string | null } | null = null;
  if (session.pendingAction) {
    anchor = {
      label: pendingActionRecencyLabel(session.pendingAction) ?? "pending",
      value:
        session.pendingStartedAt ??
        session.createdAt ??
        session.lastUsedAt ??
        session.becameIdleAt ??
        lastOutputAt,
    };
  } else {
    switch (semanticLabel) {
      case "needs_input":
      case "needs_response":
        anchor = {
          label: "prompted",
          value: latestUnreadAt ?? lastOutputAt ?? session.becameIdleAt ?? session.lastUsedAt,
        };
        break;
      case "next_step":
      case "idle":
      case "interrupted":
        anchor = output ?? { label: "idle", value: session.becameIdleAt ?? session.lastUsedAt };
        break;
      case "working":
      case "ready":
        anchor = output;
        break;
      case "done":
        anchor = output ?? { label: "done", value: session.becameIdleAt ?? session.lastUsedAt };
        break;
      case "offline":
        anchor = output ?? { label: "offline", value: session.lastUsedAt };
        break;
      case "blocked":
        anchor = {
          label: "blocked",
          value: latestUnreadAt ?? session.becameIdleAt ?? lastOutputAt ?? session.lastUsedAt,
        };
        break;
      case "error":
        anchor = {
          label: "failed",
          value: latestUnreadAt ?? session.becameIdleAt ?? lastOutputAt ?? session.lastUsedAt,
        };
        break;
      default:
        anchor = output;
        break;
    }
  }

  if (!anchor?.value) return null;
  return formatLabeledRecency(anchor.label, anchor.value, now);
}

export function formatServiceRecency(service: DesktopService, now = Date.now()): string | null {
  const value = service.pendingStartedAt ?? service.lastUsedAt ?? service.createdAt;
  const label = service.pendingAction ? pendingActionRecencyLabel(service.pendingAction) : "used";
  return formatLabeledRecency(label, value, now);
}
