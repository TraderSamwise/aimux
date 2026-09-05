import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertEvent } from "./project-events.js";

let notificationsConfig: {
  enabled: boolean;
  onPrompt: boolean;
  onError: boolean;
  onComplete: boolean;
};

vi.mock("./config.js", () => ({
  loadConfig: () => ({ notifications: notificationsConfig }),
}));
vi.mock("./notification-context.js", () => ({
  shouldSuppressNotification: vi.fn(() => false),
}));
vi.mock("node-notifier", () => ({ default: { notify: vi.fn() } }));
vi.mock("node:child_process", () => ({
  execFile: vi.fn((_file: string, _args: string[], cb?: (err: Error | null) => void) => cb?.(null)),
}));

import { notifyAlert, resetNotifyConfig } from "./notify";
import { shouldSuppressNotification } from "./notification-context.js";

const suppress = vi.mocked(shouldSuppressNotification);

function alert(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    type: "alert",
    kind: "needs_input",
    sessionId: "claude-1",
    title: "claude-1 needs input",
    message: "waiting for input",
    ts: "2026-06-06T00:00:00.000Z",
    ...overrides,
  } as AlertEvent;
}

describe("notifyAlert desktop choke point", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AIMUX_DISABLE_EXTERNAL_NOTIFICATIONS;
    delete process.env.AIMUX_DISABLE_DESKTOP_NOTIFICATIONS;
    notificationsConfig = { enabled: true, onPrompt: true, onError: true, onComplete: true };
    suppress.mockReturnValue(false);
    resetNotifyConfig();
  });

  it("sends desktop alerts when host notification settings allow them", () => {
    const event = alert();
    expect(notifyAlert(event)).toBe(true);
  });

  it("does not send when notifications are disabled", () => {
    notificationsConfig.enabled = false;
    resetNotifyConfig();
    expect(notifyAlert(alert())).toBe(false);
  });

  it("does not send externally when the test/runtime guard is enabled", () => {
    process.env.AIMUX_DISABLE_EXTERNAL_NOTIFICATIONS = "1";
    expect(notifyAlert(alert())).toBe(true);
  });

  it("does not send when the alert is focus-suppressed", () => {
    suppress.mockReturnValue(true);
    const event = alert({ projectRoot: "/tmp/project" });
    expect(notifyAlert(event)).toBe(false);
    expect(suppress).toHaveBeenCalledWith(event, "/tmp/project");
  });

  it("does not send when the alert's category gate is off", () => {
    notificationsConfig.onPrompt = false;
    resetNotifyConfig();
    expect(notifyAlert(alert({ kind: "needs_input" }))).toBe(false);
  });

  it("gates interaction requests as prompt notifications", () => {
    notificationsConfig.onPrompt = false;
    resetNotifyConfig();
    expect(notifyAlert(alert({ kind: "interaction_request" }))).toBe(false);
  });

  it("gates next-step alerts as prompt notifications", () => {
    notificationsConfig.onPrompt = false;
    resetNotifyConfig();
    expect(notifyAlert(alert({ kind: "next_step" }))).toBe(false);
  });

  it("does not forward telemetry-only interaction requests", () => {
    expect(
      notifyAlert(
        alert({
          kind: "interaction_request",
          interaction: {
            id: "interaction-1",
            type: "permission",
            telemetry: true,
          },
        }),
      ),
    ).toBe(false);
  });

  it("sends completion alerts gated by onComplete", () => {
    expect(notifyAlert(alert({ kind: "task_done" }))).toBe(true);
  });
});
