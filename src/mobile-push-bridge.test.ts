import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertEvent } from "./project-events.js";

vi.mock("./daemon-client.js", () => ({
  requestDaemonJson: vi.fn(() => Promise.resolve({ ok: true })),
}));

import { requestDaemonJson } from "./daemon-client.js";
import { forwardAlertToMobilePush } from "./mobile-push-bridge.js";

const request = vi.mocked(requestDaemonJson);

function alert(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    type: "alert",
    kind: "needs_input",
    projectId: "project-1",
    sessionId: "claude-1",
    title: "claude-1 needs input",
    message: "waiting for input",
    ts: "2026-06-06T00:00:00.000Z",
    ...overrides,
  } as AlertEvent;
}

describe("mobile push bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AIMUX_DISABLE_EXTERNAL_NOTIFICATIONS;
    delete process.env.AIMUX_DISABLE_DESKTOP_NOTIFICATIONS;
  });

  it("forwards alert payloads to the daemon", () => {
    forwardAlertToMobilePush(alert({ dedupeKey: "needs_input:claude-1" }));

    expect(request).toHaveBeenCalledWith(
      "/internal/push",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"dedupeKey":"needs_input:claude-1"'),
      }),
    );
  });

  it("does not forward when external notifications are disabled", () => {
    process.env.AIMUX_DISABLE_EXTERNAL_NOTIFICATIONS = "1";

    forwardAlertToMobilePush(alert());

    expect(request).not.toHaveBeenCalled();
  });
});
