import type { NotificationRecord } from "./notifications.js";
import type { WorkflowEntry } from "./workflow.js";

/**
 * Reconciled, agent-keyed model of the Coordination Inbox: it joins the persisted
 * notification log against live agent state (reachability + current label) so the view
 * can show "what needs me now" instead of an append-only event firehose. Pure and
 * dependency-free — callers pass plain session/service/teammate/notification/thread data.
 */

/** Can the notification's target still be reached? Mirrors notificationTargetState. */
export type CoordinationReachability = "live" | "offline" | "missing" | "none";

/** Minimal structural shape of a dashboard session/teammate the model needs. */
export interface CoordinationSessionLike {
  id: string;
  command?: string;
  label?: string;
  status?: string;
  worktreeName?: string;
  semantic?: {
    user?: { label?: string; attention?: string };
    presentation?: { attentionScore?: number };
  };
}

/** Minimal structural shape of a dashboard service the model needs. */
export interface CoordinationServiceLike {
  id: string;
  command?: string;
  label?: string;
  status?: string;
  worktreeName?: string;
}

export interface CoordinationItem {
  /** Stable key: the target sessionId, or dedupeKey/id for sessionless notifications. */
  key: string;
  sessionId?: string;
  title: string;
  reachability: CoordinationReachability;
  /** Live agent label (working/needs_input/…), when the target resolves to a session. */
  liveLabel?: string;
  attentionScore: number;
  /** Composite sort score; higher is more urgent. */
  urgency: number;
  notifications: NotificationRecord[];
  unreadCount: number;
  latestUnread?: NotificationRecord;
  /** Most-urgent genuine (non-notification) thread for this agent, if any. */
  thread?: WorkflowEntry;
  pendingDeliveries: number;
  /** Reachable + has unread/pending + not stale: it genuinely wants attention now. */
  actionable: boolean;
  /**
   * Display heuristic only (never a write): a live agent with an unread needs-input
   * notice whose current label shows it has moved on — the notice is probably stale.
   */
  stale: boolean;
}

export interface CoordinationModel {
  /** All items, most-urgent first. */
  items: CoordinationItem[];
  /** Reachable, unhandled, non-stale items — the worklist. */
  actionable: CoordinationItem[];
  /** Items whose target no longer exists. */
  unreachable: CoordinationItem[];
}

export interface BuildCoordinationModelInput {
  sessions: CoordinationSessionLike[];
  teammates?: CoordinationSessionLike[];
  services?: CoordinationServiceLike[];
  notifications: NotificationRecord[];
  threads?: WorkflowEntry[];
}

const NEEDS_INPUT_KIND = "needs_input";
// Live labels that still want the user; any other label means the agent moved on.
const WAITING_LABELS = new Set(["needs_input", "needs_response", "blocked", "error"]);

/**
 * An unread needs-input notice is stale when the live agent label has moved past a waiting
 * state — the agent is no longer asking, so the notice is probably already handled. Display
 * heuristic only (never a write); callers add their own reachability guard. Shared so the
 * dashboard and Coordination reconcile the same way.
 */
export function isNotificationStale(liveLabel: string | undefined, hasUnreadNeedsInput: boolean): boolean {
  return hasUnreadNeedsInput && liveLabel != null && !WAITING_LABELS.has(liveLabel);
}

interface Reachable {
  reachability: CoordinationReachability;
  liveLabel?: string;
  attentionScore: number;
}

function resolveReachability(
  sessionId: string | undefined,
  sessions: CoordinationSessionLike[],
  teammates: CoordinationSessionLike[],
  services: CoordinationServiceLike[],
): Reachable {
  if (!sessionId) return { reachability: "none", attentionScore: 0 };
  const session = sessions.find((s) => s.id === sessionId) ?? teammates.find((t) => t.id === sessionId);
  if (session) {
    return {
      reachability: session.status === "offline" ? "offline" : "live",
      liveLabel: session.semantic?.user?.label,
      attentionScore: session.semantic?.presentation?.attentionScore ?? 0,
    };
  }
  const service = services.find((svc) => svc.id === sessionId);
  if (service) return { reachability: service.status === "running" ? "live" : "offline", attentionScore: 0 };
  return { reachability: "missing", attentionScore: 0 };
}

/** Genuine thread whose participants include this session, most urgent first. */
function threadForSession(sessionId: string, threads: WorkflowEntry[]): WorkflowEntry | undefined {
  return threads
    .filter(
      (entry) =>
        entry.thread.participants.includes(sessionId) ||
        entry.thread.owner === sessionId ||
        (entry.thread.waitingOn ?? []).includes(sessionId),
    )
    .sort((a, b) => b.urgency - a.urgency)[0];
}

// Lower bucket = more urgent; the dominant term of the sort.
function bucketOf(item: { reachability: CoordinationReachability; actionable: boolean; stale: boolean }): number {
  if (item.actionable && item.reachability === "live") return 0;
  if (item.actionable && item.reachability === "offline") return 1;
  if (item.actionable) return 2; // standalone (none)
  if (item.stale) return 3;
  if (item.reachability === "missing") return 5;
  return 4; // read / handled, still reachable
}

function buildItem(
  key: string,
  sessionId: string | undefined,
  group: NotificationRecord[],
  reachable: Reachable,
  threads: WorkflowEntry[],
): CoordinationItem {
  const unread = group.filter((n) => n.unread);
  const latestUnread = [...unread].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const thread = sessionId ? threadForSession(sessionId, threads) : undefined;
  const pendingDeliveries = thread?.pendingDeliveries ?? 0;
  const hasUnreadNeedsInput = group.some((n) => n.unread && n.kind === NEEDS_INPUT_KIND);
  const stale = reachable.reachability === "live" && isNotificationStale(reachable.liveLabel, hasUnreadNeedsInput);
  const actionable =
    reachable.reachability !== "missing" && (unread.length > 0 || pendingDeliveries > 0) && !stale;
  const item: CoordinationItem = {
    key,
    sessionId,
    title: latestUnread?.title ?? group[0]?.title ?? "aimux",
    reachability: reachable.reachability,
    liveLabel: reachable.liveLabel,
    attentionScore: reachable.attentionScore,
    urgency: 0,
    notifications: group,
    unreadCount: unread.length,
    latestUnread,
    thread,
    pendingDeliveries,
    actionable,
    stale,
  };
  const bucket = bucketOf(item);
  item.urgency =
    (10 - bucket) * 1_000_000 + reachable.attentionScore * 1000 + unread.length * 10 + pendingDeliveries * 5;
  return item;
}

export function buildCoordinationModel(input: BuildCoordinationModelInput): CoordinationModel {
  const sessions = input.sessions ?? [];
  const teammates = input.teammates ?? [];
  const services = input.services ?? [];
  const threads = input.threads ?? [];

  // Group notifications by target session; sessionless ones group by dedupeKey (falling back
  // to their id, which is unique) so repeat project-level alerts collapse into one row.
  const bySession = new Map<string, NotificationRecord[]>();
  const standalone = new Map<string, NotificationRecord[]>();
  for (const notification of input.notifications) {
    if (notification.sessionId) {
      const existing = bySession.get(notification.sessionId) ?? [];
      existing.push(notification);
      bySession.set(notification.sessionId, existing);
    } else {
      const key = notification.dedupeKey || notification.id;
      const existing = standalone.get(key) ?? [];
      existing.push(notification);
      standalone.set(key, existing);
    }
  }

  const items: CoordinationItem[] = [];
  for (const [sessionId, group] of bySession) {
    items.push(buildItem(sessionId, sessionId, group, resolveReachability(sessionId, sessions, teammates, services), threads));
  }
  for (const [key, group] of standalone) {
    items.push(buildItem(key, undefined, group, { reachability: "none", attentionScore: 0 }, threads));
  }

  items.sort((a, b) => b.urgency - a.urgency || (b.latestUnread?.createdAt ?? "").localeCompare(a.latestUnread?.createdAt ?? ""));

  return {
    items,
    actionable: items.filter((item) => item.actionable),
    unreachable: items.filter((item) => item.reachability === "missing"),
  };
}

/** Per-row record kind for the unified worklist. */
export type WorklistType = "msg" | "note" | "task" | "review" | "handoff" | "conversation";
/**
 * Urgency grouping for the unified worklist. "Needs you" is split by reachability so the
 * agents you can act on now (awake) are separated from ones you must wake first (asleep).
 */
export type WorklistBucket = "awake" | "asleep" | "handled" | "unreachable";

/**
 * One row of the unified Coordination worklist — either an agent's notification rollup or a
 * genuine (non-notification) thread, merged into a single urgency-sorted stream.
 */
export interface WorklistItem {
  /** Unique across the merged stream ("n:<key>" for notifications, "t:<threadId>" for threads). */
  key: string;
  kind: "notification" | "thread";
  /** Target session for notification rows (undefined for threads / sessionless notes). */
  sessionId?: string;
  type: WorklistType;
  bucket: WorklistBucket;
  title: string;
  /** Unified sort score (higher = more urgent); comparable across notifications and threads. */
  urgency: number;
  reachability: CoordinationReachability;
  actionable: boolean;
  stale: boolean;
  /** Recency anchor for tie-breaking / display. */
  when?: string;
  notification?: CoordinationItem;
  thread?: WorkflowEntry;
}

export interface CoordinationWorklist {
  /** All rows, most-urgent first. */
  items: WorklistItem[];
  /** Rows that genuinely want attention now. */
  needsYou: WorklistItem[];
  /** Handled / stale / unreachable rows (the de-emphasized tail). */
  tail: WorklistItem[];
}

function threadType(kind: string): WorklistType {
  return kind === "task" || kind === "review" || kind === "handoff" || kind === "conversation" ? kind : "conversation";
}

function notificationBucket(item: CoordinationItem): WorklistBucket {
  // A stale notice belongs to a LIVE agent that moved on — handled, not unreachable.
  if (item.reachability === "missing") return "unreachable";
  if (item.stale || !item.actionable) return "handled";
  // Reachable + actionable: offline agents must be woken first; live/sessionless can act now.
  return item.reachability === "offline" ? "asleep" : "awake";
}

// Bucket dominates the sort so each group renders as one contiguous run (no repeated headers).
const BUCKET_RANK: Record<WorklistBucket, number> = { awake: 4, asleep: 3, handled: 2, unreachable: 1 };

// Unified urgency so notifications and threads interleave on one scale, bucket-first.
function notificationUrgency(item: CoordinationItem, bucket: WorklistBucket): number {
  const secondary = item.attentionScore * 100 + item.unreadCount * 10 + item.pendingDeliveries * 5;
  return BUCKET_RANK[bucket] * 1_000_000 + secondary;
}

/**
 * Merge the reconciled notification model and the genuine (non-notification) threads into one
 * agent-keyed, urgency-sorted worklist. Threads are first-class rows (the model's per-item
 * thread annotation is ignored here) so each thread appears exactly once. The caller must pass
 * only genuine threads in `input.threads` (e.g. buildCoordinationThreadEntries output, which
 * already excludes notification-tagged threads) — this function does not re-filter them.
 */
export function buildCoordinationWorklist(
  input: BuildCoordinationModelInput & { currentParticipant?: string; model?: CoordinationModel },
): CoordinationWorklist {
  const participant = input.currentParticipant ?? "user";
  const model = input.model ?? buildCoordinationModel(input);
  const items: WorklistItem[] = [];

  for (const item of model.items) {
    const bucket = notificationBucket(item);
    items.push({
      key: `n:${item.key}`,
      kind: "notification",
      sessionId: item.sessionId,
      type: item.sessionId ? "msg" : "note",
      bucket,
      title: item.title,
      urgency: notificationUrgency(item, bucket),
      reachability: item.reachability,
      actionable: item.actionable,
      stale: item.stale,
      when: item.latestUnread?.createdAt,
      notification: item,
    });
  }

  for (const entry of input.threads ?? []) {
    const onYou = (entry.thread.waitingOn ?? []).includes(participant);
    const pending = entry.pendingDeliveries > 0;
    const actionable = onYou || pending;
    // Threads target the user directly (no agent to wake), so an actionable thread is "awake".
    const bucket: WorklistBucket = actionable ? "awake" : "handled";
    items.push({
      key: `t:${entry.thread.id}`,
      kind: "thread",
      type: threadType(entry.thread.kind),
      bucket,
      title: entry.displayTitle,
      urgency: BUCKET_RANK[bucket] * 1_000_000 + (onYou ? 300 : pending ? 200 : 50),
      reachability: "none",
      actionable,
      stale: false,
      when: entry.thread.updatedAt,
      thread: entry,
    });
  }

  items.sort((a, b) => b.urgency - a.urgency || (b.when ?? "").localeCompare(a.when ?? ""));

  const needsYou = items.filter((item) => item.bucket === "awake" || item.bucket === "asleep");
  return {
    items,
    needsYou,
    tail: items.filter((item) => !needsYou.includes(item)),
  };
}
