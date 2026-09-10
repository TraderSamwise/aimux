import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));

import { deliverBrowserNotification } from "./browser-notifications";
import type { ClientNotificationEvent } from "./notification-policy";

const event = {
  id: "notification-1",
  category: "agent",
  kind: "needs_input",
  title: "aimux / Main Checkout (master)",
  body: "Needs input: claude @ Main Checkout - Claude is waiting for your input",
  dedupeKey: "agent:notification-1",
} satisfies ClientNotificationEvent;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("browser notifications", () => {
  it("reports delivered when the browser accepts the notification", () => {
    const delivered: Array<{ title: string; body?: string }> = [];
    class SuccessfulNotification {
      static permission = "granted" as const;

      constructor(title: string, options?: { body?: string }) {
        delivered.push({ title, body: options?.body });
      }
    }
    vi.stubGlobal("Notification", SuccessfulNotification);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = deliverBrowserNotification(event);

    expect(result).toEqual({ status: "delivered" });
    expect(delivered).toEqual([{ title: event.title, body: event.body }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports constructor failures with the browser error", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    class FailingNotification {
      static permission = "granted" as const;

      constructor() {
        throw new Error("blocked by browser");
      }
    }
    vi.stubGlobal("Notification", FailingNotification);

    expect(deliverBrowserNotification(event)).toEqual({
      status: "failed",
      error: "blocked by browser",
    });
    expect(warn).toHaveBeenCalledWith("browser notification not delivered:", {
      reason: "constructor failed: blocked by browser",
      notificationId: event.id,
      category: event.category,
      kind: event.kind,
      title: event.title,
    });
  });

  it("logs permission denial instead of dropping it as an ignored false", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    class DeniedNotification {
      static permission = "denied" as const;
    }
    vi.stubGlobal("Notification", DeniedNotification);
    const result = deliverBrowserNotification(event);

    expect(result).toEqual({ status: "permission_denied", permission: "denied" });
    expect(warn).toHaveBeenCalledWith("browser notification not delivered:", {
      reason: "permission denied",
      notificationId: event.id,
      category: event.category,
      kind: event.kind,
      title: event.title,
    });
  });
});
