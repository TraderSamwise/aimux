import { describe, expect, it, vi } from "vitest";

import { observeNotificationStartup } from "./notification-startup";

describe("notification startup reporting", () => {
  it("reports push registration failures with a visible issue and warning", async () => {
    const onIssue = vi.fn();
    const onClear = vi.fn();
    const warn = vi.fn();

    await expect(
      observeNotificationStartup({
        source: "push_registration",
        operation: async () => {
          throw new Error("relay rejected token");
        },
        onIssue,
        onClear,
        warn,
      }),
    ).resolves.toBeNull();

    expect(onClear).not.toHaveBeenCalled();
    expect(onIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "push_registration",
        title: "Notifications degraded",
        body: "Push registration failed: relay rejected token",
        error: "relay rejected token",
      }),
    );
    expect(warn).toHaveBeenCalledWith("notification startup degraded:", {
      source: "push_registration",
      error: "relay rejected token",
    });
  });

  it("reports security channel failures with the cause", async () => {
    const onIssue = vi.fn();
    const warn = vi.fn();

    await observeNotificationStartup({
      source: "security_channel",
      operation: async () => {
        throw new Error("channel permission denied");
      },
      onIssue,
      onClear: vi.fn(),
      warn,
    });

    expect(onIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "security_channel",
        body: "Security notification channel setup failed: channel permission denied",
        error: "channel permission denied",
      }),
    );
    expect(warn).toHaveBeenCalledWith("notification startup degraded:", {
      source: "security_channel",
      error: "channel permission denied",
    });
  });

  it("keeps successful startup silent and clears prior failures", async () => {
    const onIssue = vi.fn();
    const onClear = vi.fn();
    const warn = vi.fn();

    await expect(
      observeNotificationStartup({
        source: "push_registration",
        operation: async () => "registered",
        onIssue,
        onClear,
        warn,
      }),
    ).resolves.toBe("registered");

    expect(onIssue).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(onClear).toHaveBeenCalledWith("push_registration");
  });
});
