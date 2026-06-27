import type { InboxConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { clearNotifications, listNotifications, type NotificationRecord } from "./notifications.js";

/**
 * Notification-inbox cleanup, mirroring graveyard cleanup. Pure planning + an executor with
 * an injectable clear op. Archives read/handled notifications past the retention window and
 * trims the inbox to a soft maxSize — but never an unread actionable row (see protectedIds).
 */

const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_MAX_SIZE = 10;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface InboxCleanupConfig {
  cleanupEnabled: boolean;
  retentionDays: number;
  maxSize: number;
}

export interface InboxCleanupTarget {
  id: string;
  reason: "aged" | "overflow";
  createdAt: string;
  sessionId?: string;
}

export interface InboxCleanupPlan {
  enabled: boolean;
  now: string;
  cutoff: string;
  retentionDays: number;
  maxSize: number;
  targets: InboxCleanupTarget[];
}

export interface InboxCleanupItemResult {
  id: string;
  reason: "aged" | "overflow";
  status: "cleared" | "dry-run" | "failed";
  error?: string;
}

export interface InboxCleanupRunResult {
  dryRun: boolean;
  plan: InboxCleanupPlan;
  results: InboxCleanupItemResult[];
}

export interface InboxCleanupOperations {
  clear?: (id: string) => number;
}

function normalizeCleanupConfig(config: Partial<InboxConfig> | undefined): InboxCleanupConfig {
  const retentionDays = typeof config?.retentionDays === "number" ? config.retentionDays : Number.NaN;
  const maxSize = typeof config?.maxSize === "number" ? config.maxSize : Number.NaN;
  return {
    cleanupEnabled: config?.cleanupEnabled !== false,
    retentionDays: Number.isFinite(retentionDays) && retentionDays >= 0 ? retentionDays : DEFAULT_RETENTION_DAYS,
    maxSize: Number.isFinite(maxSize) && maxSize >= 0 ? maxSize : DEFAULT_MAX_SIZE,
  };
}

function parseTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function buildInboxCleanupPlan(input?: {
  now?: Date | string;
  config?: Partial<InboxConfig>;
  notifications?: NotificationRecord[];
  /** Ids that must never be archived. Defaults to every unread notification. */
  protectedIds?: Set<string>;
}): InboxCleanupPlan {
  const config = normalizeCleanupConfig(input?.config ?? loadConfig().inbox);
  const now = input?.now instanceof Date ? input.now : new Date(input?.now ?? Date.now());
  const nowMs = now.getTime();
  const cutoffMs = nowMs - config.retentionDays * MS_PER_DAY;
  const notifications = input?.notifications ?? listNotifications();
  const isProtected = (record: NotificationRecord): boolean =>
    input?.protectedIds ? input.protectedIds.has(record.id) : record.unread;

  if (!config.cleanupEnabled) {
    return {
      enabled: false,
      now: now.toISOString(),
      cutoff: new Date(cutoffMs).toISOString(),
      retentionDays: config.retentionDays,
      maxSize: config.maxSize,
      targets: [],
    };
  }

  const targets: InboxCleanupTarget[] = [];
  const targetIds = new Set<string>();

  // Aged: read/handled notifications that have lingered past the retention window. Unread
  // notifications are never aged out — they persist until handled (or capped as overflow).
  for (const record of notifications) {
    if (isProtected(record)) continue;
    const createdMs = parseTime(record.createdAt);
    if (!record.unread && createdMs !== undefined && createdMs <= cutoffMs) {
      targets.push({ id: record.id, reason: "aged", createdAt: record.createdAt, sessionId: record.sessionId });
      targetIds.add(record.id);
    }
  }

  // Overflow: if still above the soft cap, archive non-protected extras — read first, then
  // oldest — so the cap never evicts a protected (unread actionable) row.
  const retained = notifications.length - targetIds.size;
  if (retained > config.maxSize) {
    const evictable = notifications
      .filter((record) => !targetIds.has(record.id) && !isProtected(record))
      .sort((a, b) => (a.unread === b.unread ? a.createdAt.localeCompare(b.createdAt) : a.unread ? 1 : -1));
    let need = retained - config.maxSize;
    for (const record of evictable) {
      if (need <= 0) break;
      targets.push({ id: record.id, reason: "overflow", createdAt: record.createdAt, sessionId: record.sessionId });
      targetIds.add(record.id);
      need -= 1;
    }
  }

  return {
    enabled: true,
    now: now.toISOString(),
    cutoff: new Date(cutoffMs).toISOString(),
    retentionDays: config.retentionDays,
    maxSize: config.maxSize,
    targets,
  };
}

export function runInboxCleanup(
  plan: InboxCleanupPlan,
  operations: InboxCleanupOperations = {},
  input?: { dryRun?: boolean },
): InboxCleanupRunResult {
  const dryRun = input?.dryRun === true;
  const results: InboxCleanupItemResult[] = [];
  if (!plan.enabled) return { dryRun, plan, results };
  const clear = operations.clear ?? ((id: string) => clearNotifications({ id }));

  for (const target of plan.targets) {
    if (dryRun) {
      results.push({ id: target.id, reason: target.reason, status: "dry-run" });
      continue;
    }
    try {
      const cleared = clear(target.id);
      results.push(
        cleared > 0
          ? { id: target.id, reason: target.reason, status: "cleared" }
          : { id: target.id, reason: target.reason, status: "failed", error: "notification not found" },
      );
    } catch (error) {
      results.push({
        id: target.id,
        reason: target.reason,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { dryRun, plan, results };
}
