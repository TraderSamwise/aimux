import type { NotificationRecord } from "@/lib/api";
import type { DesktopService, DesktopSession, DesktopState } from "@/lib/desktop-state";
import type { SecurityInboxEvent } from "@/stores/security";

export type ForYouKind = "action-required" | "approval" | "shipped" | "progress" | "observation";
export type ForYouSource = "notification" | "security" | "agent" | "service";

export interface ForYouCard {
  id: string;
  kind: ForYouKind;
  source: ForYouSource;
  actionable?: boolean;
  title: string;
  body?: string;
  subtitle?: string;
  createdAt: string;
  unread: boolean;
  sessionId?: string;
  serviceId?: string;
  notificationId?: string;
  securityId?: string;
}

export interface ForYouFeedInput {
  notifications: NotificationRecord[];
  securityEvents: SecurityInboxEvent[];
  desktopState: DesktopState | null;
}

export interface ForYouFeed {
  cards: ForYouCard[];
  counts: Record<ForYouKind, number>;
}

const EMPTY_COUNTS: Record<ForYouKind, number> = {
  "action-required": 0,
  approval: 0,
  shipped: 0,
  progress: 0,
  observation: 0,
};

function normalize(value?: string): string {
  return value?.trim().toLowerCase().replace(/[_-]+/g, " ") ?? "";
}

export function classifyNotification(record: NotificationRecord): ForYouKind {
  if (record.interaction?.telemetry) return "observation";
  if (record.kind === "interaction_request") {
    return record.interaction?.type === "permission" ? "approval" : "action-required";
  }

  const haystack = [record.kind, record.targetKind, record.title, record.subtitle, record.body]
    .map(normalize)
    .join(" ");

  if (
    haystack.includes("approval") ||
    haystack.includes("approve") ||
    haystack.includes("review") ||
    haystack.includes("decision") ||
    haystack.includes("ratify")
  ) {
    return "approval";
  }
  if (
    haystack.includes("handoff waiting") ||
    haystack.includes("needs input") ||
    haystack.includes("blocked") ||
    haystack.includes("waiting")
  ) {
    return "action-required";
  }
  if (
    haystack.includes("complete") ||
    haystack.includes("completed") ||
    haystack.includes("closed") ||
    haystack.includes("shipped") ||
    haystack.includes("done")
  ) {
    return "shipped";
  }
  if (record.unread && record.sessionId) return "action-required";
  if (haystack.includes("progress") || haystack.includes("activity")) return "progress";
  return "observation";
}

function pendingAgentCard(session: DesktopSession): ForYouCard | null {
  if (!session.pendingAction && session.status !== "waiting") return null;
  return {
    id: `agent:${session.id}:attention`,
    kind: "action-required",
    source: "agent",
    title: session.label || session.id,
    body: session.pendingAction || session.previewLine || session.headline || "Agent is waiting",
    subtitle: [session.worktreeName, session.status].filter(Boolean).join(" · "),
    createdAt: new Date(0).toISOString(),
    unread: true,
    sessionId: session.id,
  };
}

function pendingServiceCard(service: DesktopService): ForYouCard | null {
  if (!service.pendingAction) return null;
  return {
    id: `service:${service.id}:attention`,
    kind: "action-required",
    source: "service",
    title: service.label || service.id,
    body: service.pendingAction,
    subtitle: [service.worktreeName, service.status].filter(Boolean).join(" · "),
    createdAt: new Date(0).toISOString(),
    unread: true,
    serviceId: service.id,
  };
}

function notificationCard(record: NotificationRecord): ForYouCard {
  return {
    id: `notification:${record.id}`,
    kind: classifyNotification(record),
    source: "notification",
    actionable: Boolean(record.interaction && !record.interaction.telemetry),
    title: record.title || record.subtitle || "aimux",
    body: record.body,
    subtitle: [record.subtitle, record.kind?.replace(/[_-]+/g, " "), record.sessionId]
      .filter(Boolean)
      .join(" · "),
    createdAt: record.createdAt,
    unread: record.unread,
    sessionId: record.sessionId,
    notificationId: record.id,
  };
}

function securityCard(event: SecurityInboxEvent): ForYouCard {
  return {
    id: `security:${event.id}`,
    kind: "action-required",
    source: "security",
    title: event.title || "Security alert",
    body: event.body,
    subtitle: [event.kind.replace(/[_-]+/g, " "), event.country].filter(Boolean).join(" · "),
    createdAt: event.createdAt,
    unread: !event.readAt,
    securityId: event.id,
  };
}

function sortTime(card: ForYouCard): number {
  const parsed = Date.parse(card.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function buildForYouFeed(input: ForYouFeedInput): ForYouFeed {
  const cards = [
    ...input.securityEvents.map(securityCard),
    ...input.notifications.map(notificationCard),
    ...(input.desktopState?.sessions.map(pendingAgentCard).filter(Boolean) ?? []),
    ...(input.desktopState?.services.map(pendingServiceCard).filter(Boolean) ?? []),
  ].filter((card): card is ForYouCard => Boolean(card));

  cards.sort((a, b) => {
    if (a.unread !== b.unread) return a.unread ? -1 : 1;
    return sortTime(b) - sortTime(a);
  });

  const counts = { ...EMPTY_COUNTS };
  for (const card of cards) counts[card.kind] += 1;

  return { cards, counts };
}
