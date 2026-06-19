import { describe, expect, it } from "vitest";

import { buildInboxCleanupPlan, runInboxCleanup } from "./inbox-cleanup.js";
import type { InboxConfig } from "./config.js";
import type { NotificationRecord } from "./notifications.js";

const NOW = "2026-06-19T00:00:00.000Z";
const OLD = "2026-05-01T00:00:00.000Z"; // > 14 days before NOW
const RECENT = "2026-06-18T00:00:00.000Z";

const CONFIG: InboxConfig = { cleanupEnabled: true, retentionDays: 14, cleanupIntervalMs: 86_400_000, maxSize: 10 };

function notif(id: string, over: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id,
    title: "title",
    body: "body",
    unread: false,
    cleared: false,
    createdAt: RECENT,
    updatedAt: RECENT,
    ...over,
  };
}

describe("inbox cleanup plan", () => {
  it("ages out read notifications past retention but never unread ones", () => {
    const plan = buildInboxCleanupPlan({
      now: NOW,
      config: { ...CONFIG, maxSize: 100 },
      notifications: [
        notif("old-read", { unread: false, createdAt: OLD }),
        notif("old-unread", { unread: true, createdAt: OLD }),
        notif("recent-read", { unread: false, createdAt: RECENT }),
      ],
    });
    expect(plan.targets.map((t) => t.id)).toEqual(["old-read"]);
    expect(plan.targets[0]!.reason).toBe("aged");
  });

  it("trims overflow beyond maxSize, evicting oldest read first", () => {
    const plan = buildInboxCleanupPlan({
      now: NOW,
      config: { ...CONFIG, maxSize: 2 },
      notifications: [
        notif("r1", { createdAt: "2026-06-10T00:00:00.000Z" }),
        notif("r2", { createdAt: "2026-06-11T00:00:00.000Z" }),
        notif("r3", { createdAt: "2026-06-12T00:00:00.000Z" }),
        notif("r4", { createdAt: "2026-06-13T00:00:00.000Z" }),
        notif("r5", { createdAt: "2026-06-14T00:00:00.000Z" }),
      ],
    });
    expect(plan.targets.map((t) => t.id)).toEqual(["r1", "r2", "r3"]);
    expect(plan.targets.every((t) => t.reason === "overflow")).toBe(true);
  });

  it("never evicts a protected (unread actionable) row even when over the cap", () => {
    const plan = buildInboxCleanupPlan({
      now: NOW,
      config: { ...CONFIG, maxSize: 1 },
      notifications: [notif("u1", { unread: true }), notif("r1", { unread: false }), notif("r2", { unread: false })],
      protectedIds: new Set(["u1"]),
    });
    expect(plan.targets.map((t) => t.id).sort()).toEqual(["r1", "r2"]);
  });

  it("keeps a protected row even when maxSize is 0", () => {
    const plan = buildInboxCleanupPlan({
      now: NOW,
      config: { ...CONFIG, maxSize: 0 },
      notifications: [notif("u1", { unread: true })],
    });
    expect(plan.enabled).toBe(true);
    expect(plan.targets).toHaveLength(0);
  });

  it("defaults to protecting every unread notification", () => {
    const plan = buildInboxCleanupPlan({
      now: NOW,
      config: { ...CONFIG, maxSize: 0 },
      notifications: [notif("u1", { unread: true }), notif("r1", { unread: false })],
    });
    expect(plan.targets.map((t) => t.id)).toEqual(["r1"]);
  });

  it("returns no targets when cleanup is disabled", () => {
    const plan = buildInboxCleanupPlan({
      now: NOW,
      config: { ...CONFIG, cleanupEnabled: false, maxSize: 0 },
      notifications: [notif("r1", { unread: false })],
    });
    expect(plan.enabled).toBe(false);
    expect(plan.targets).toHaveLength(0);
  });
});

describe("inbox cleanup run", () => {
  const plan = buildInboxCleanupPlan({
    now: NOW,
    config: { ...CONFIG, maxSize: 0 },
    notifications: [notif("r1", { unread: false })],
    protectedIds: new Set(),
  });

  it("does not clear on a dry run", () => {
    const cleared: string[] = [];
    const result = runInboxCleanup(plan, { clear: (id) => (cleared.push(id), 1) }, { dryRun: true });
    expect(cleared).toHaveLength(0);
    expect(result.results[0]!.status).toBe("dry-run");
  });

  it("clears targets and reports failures when nothing was cleared", () => {
    const cleared: string[] = [];
    const ok = runInboxCleanup(plan, { clear: (id) => (cleared.push(id), 1) });
    expect(cleared).toEqual(["r1"]);
    expect(ok.results[0]!.status).toBe("cleared");

    const miss = runInboxCleanup(plan, { clear: () => 0 });
    expect(miss.results[0]!.status).toBe("failed");
  });
});
