import { describe, expect, it } from "vitest";

import type { NotificationRecord } from "@/lib/api";
import type { GlobalNotificationRow } from "@/stores/globalInbox";
import {
  filterGlobalNotificationRows,
  normalizeGlobalNotificationScope,
  splitGlobalNotificationRows,
} from "./global-notification-feed";

function notification(id: string, overrides: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id,
    title: `Notification ${id}`,
    body: `Body ${id}`,
    sessionId: "session-1",
    kind: "agent",
    unread: true,
    cleared: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function row(
  projectName: string,
  projectPath: string,
  id: string,
  overrides: Partial<NotificationRecord> = {},
): GlobalNotificationRow {
  return { projectName, projectPath, notification: notification(id, overrides) };
}

describe("global notification feed", () => {
  it("normalizes unknown scopes to all", () => {
    expect(normalizeGlobalNotificationScope("project")).toBe("project");
    expect(normalizeGlobalNotificationScope("read")).toBe("all");
    expect(normalizeGlobalNotificationScope(null)).toBe("all");
  });

  it("keeps read notifications and demarcates them below unread", () => {
    const sections = splitGlobalNotificationRows([
      row("Aimux", "/aimux", "read-newer", {
        unread: false,
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
      row("Aimux", "/aimux", "unread-older", {
        unread: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);

    expect(sections.unread.map((item) => item.notification.id)).toEqual(["unread-older"]);
    expect(sections.read.map((item) => item.notification.id)).toEqual(["read-newer"]);
  });

  it("filters the flattened feed to one project", () => {
    expect(
      filterGlobalNotificationRows(
        [row("Aimux", "/aimux", "aimux-1"), row("The Grand", "/thegrand", "grand-1")],
        "project",
        "/thegrand",
      ).map((item) => item.notification.id),
    ).toEqual(["grand-1"]);
  });

  it("falls back to all rows when project scope has no project", () => {
    expect(
      filterGlobalNotificationRows(
        [row("Aimux", "/aimux", "aimux-1"), row("The Grand", "/thegrand", "grand-1")],
        "project",
        null,
      ).map((item) => item.notification.id),
    ).toEqual(["aimux-1", "grand-1"]);
  });

  it("uses deterministic tie breakers for matching timestamps", () => {
    expect(
      filterGlobalNotificationRows(
        [
          row("The Grand", "/thegrand", "b", { title: "B" }),
          row("Aimux", "/aimux", "z", { title: "Z" }),
          row("Aimux", "/aimux", "a", { title: "A" }),
        ],
        "all",
        null,
      ).map((item) => `${item.projectName}:${item.notification.title}:${item.notification.id}`),
    ).toEqual(["Aimux:A:a", "Aimux:Z:z", "The Grand:B:b"]);
  });
});
