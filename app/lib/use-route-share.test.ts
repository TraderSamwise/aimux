import { describe, expect, it } from "vitest";
import { resolveRouteShare } from "./route-share-resolver";
import type { ActiveSharedSession } from "@/stores/settings";

const share: ActiveSharedSession = {
  shareId: "share_123",
  ownerUserId: "user_owner",
  projectRoot: "/Users/sam/cs/scratch",
  sessionId: "claude-k4lihz",
  serviceEndpoint: { host: "relay.aimux.app", port: 443 },
  acceptedAt: "2026-08-13T00:00:00.000Z",
};

describe("resolveRouteShare", () => {
  it("resolves canonical shared chat routes", () => {
    expect(
      resolveRouteShare({
        acceptedShares: [share],
        legacyActiveShare: null,
        ownerUserId: share.ownerUserId,
        pathname: "/shares/user_owner/share_123/agent/claude-k4lihz/chat",
        sessionId: share.sessionId,
        shareId: share.shareId,
      }),
    ).toEqual(share);
  });

  it("resolves legacy agent chat routes for accepted shared sessions", () => {
    expect(
      resolveRouteShare({
        acceptedShares: [share],
        currentUserId: "user_guest",
        legacyActiveShare: null,
        pathname: "/agent/claude-k4lihz/chat",
        routeProjectPath: share.projectRoot,
        sessionId: share.sessionId,
      }),
    ).toEqual(share);
  });

  it("waits for a current user before resolving legacy shared routes", () => {
    expect(
      resolveRouteShare({
        acceptedShares: [share],
        legacyActiveShare: null,
        pathname: "/agent/claude-k4lihz/chat",
        routeProjectPath: share.projectRoot,
        sessionId: share.sessionId,
      }),
    ).toBeNull();
  });

  it("leaves owner project routes in the normal project experience", () => {
    expect(
      resolveRouteShare({
        acceptedShares: [share],
        currentUserId: share.ownerUserId,
        legacyActiveShare: null,
        pathname: "/agent/claude-k4lihz/chat",
        routeProjectPath: share.projectRoot,
        sessionId: share.sessionId,
      }),
    ).toBeNull();

    expect(
      resolveRouteShare({
        acceptedShares: [share],
        currentUserId: share.ownerUserId,
        legacyActiveShare: null,
        ownerUserId: share.ownerUserId,
        pathname: "/shares/user_owner/share_123/agent/claude-k4lihz/chat",
        sessionId: share.sessionId,
        shareId: share.shareId,
      }),
    ).toEqual(share);
  });

  it("resolves leaked project routes only when they match the active shared session", () => {
    expect(
      resolveRouteShare({
        acceptedShares: [],
        currentUserId: "user_guest",
        legacyActiveShare: share,
        pathname: "/project",
        routeProjectPath: share.projectRoot,
      }),
    ).toEqual(share);

    expect(
      resolveRouteShare({
        acceptedShares: [share],
        legacyActiveShare: null,
        pathname: "/project",
        routeProjectPath: "/Users/sam/cs/local",
      }),
    ).toBeNull();
  });

  it("does not treat ordinary local agent routes as shared", () => {
    expect(
      resolveRouteShare({
        acceptedShares: [share],
        legacyActiveShare: null,
        pathname: "/agent/local-session/chat",
        routeProjectPath: share.projectRoot,
        sessionId: "local-session",
      }),
    ).toBeNull();
  });
});
