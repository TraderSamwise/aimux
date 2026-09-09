import { describe, expect, it } from "vitest";
import { buildAimuxNotificationDeepLink } from "./notification-deep-link.js";

describe("Aimux notification deep links", () => {
  it("builds a chat URL with project, notification, and focus token params", () => {
    expect(
      buildAimuxNotificationDeepLink({
        projectRoot: "/Users/sam/cs/aimux",
        sessionId: "codex-u1iogs",
        notificationId: "notice 1",
      }),
    ).toBe(
      "aimux:///agent/codex-u1iogs/chat?project=%2FUsers%2Fsam%2Fcs%2Faimux&notificationId=notice+1&focusToken=notice+1",
    );
  });

  it("does not build partial notification URLs", () => {
    expect(buildAimuxNotificationDeepLink({ projectRoot: "/tmp/a", sessionId: "codex-1" })).toBeNull();
    expect(buildAimuxNotificationDeepLink({ projectRoot: "/tmp/a", notificationId: "n1" })).toBeNull();
    expect(buildAimuxNotificationDeepLink({ sessionId: "codex-1", notificationId: "n1" })).toBeNull();
  });
});
