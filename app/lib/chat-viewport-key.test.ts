import { describe, expect, it } from "vitest";
import { chatViewportKeyForRoute } from "./chat-viewport-key";

describe("chatViewportKeyForRoute", () => {
  it("changes when the route project changes", () => {
    expect(
      chatViewportKeyForRoute({
        projectPath: "/repo/a",
        sessionKey: "claude-1",
      }),
    ).not.toBe(
      chatViewportKeyForRoute({
        projectPath: "/repo/b",
        sessionKey: "claude-1",
      }),
    );
  });

  it("changes when a notification focus token changes", () => {
    expect(
      chatViewportKeyForRoute({
        focusToken: "tap-1",
        projectPath: "/repo",
        sessionKey: "claude-1",
      }),
    ).not.toBe(
      chatViewportKeyForRoute({
        focusToken: "tap-2",
        projectPath: "/repo",
        sessionKey: "claude-1",
      }),
    );
  });

  it("separates shared chat scope from local project scope", () => {
    expect(
      chatViewportKeyForRoute({
        projectPath: "/repo",
        sessionKey: "claude-1",
      }),
    ).not.toBe(
      chatViewportKeyForRoute({
        projectPath: "/repo",
        sessionKey: "claude-1",
        share: {
          ownerUserId: "user-1",
          projectRoot: "/repo",
          shareId: "share-1",
        },
      }),
    );
  });
});
