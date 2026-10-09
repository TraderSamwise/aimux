import { describe, expect, it } from "vitest";
import { resolveRouteShare, sharedChatHref } from "./route-share-resolver";
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

  it("builds canonical shared chat hrefs", () => {
    expect(sharedChatHref(share)).toEqual({
      pathname: "/shares/[ownerUserId]/[shareId]/agent/[sessionId]/chat",
      params: {
        ownerUserId: share.ownerUserId,
        shareId: share.shareId,
        sessionId: share.sessionId,
      },
    });
  });
});

describe("a bare launch is not a shared route", () => {
  // The reported bug, and the dominant half of it. `(main)/_layout.tsx` does
  // `router.replace(sharedChatHref(activeShare))` for whatever this resolves,
  // with no relay input, so resolving an unnamed share here opened the app on
  // someone else's chat however healthy the user's own backend was.
  it.each(["/", "/project", "/coordination", "/topology", "/library"])(
    "resolves nothing at %s when the route names no share",
    (pathname) => {
      expect(
        resolveRouteShare({
          acceptedShares: [share],
          currentUserId: "user_me",
          legacyActiveShare: null,
          pathname,
        }),
      ).toBeNull();
    },
  );

  // Route evidence is what makes it a shared route, and either half will do.
  it("still resolves when the route names the session", () => {
    expect(
      resolveRouteShare({
        acceptedShares: [share],
        currentUserId: "user_me",
        legacyActiveShare: null,
        pathname: "/project",
        sessionId: share.sessionId,
      }),
    ).toEqual(share);
  });

  it("still resolves when the route names the project", () => {
    expect(
      resolveRouteShare({
        acceptedShares: [share],
        currentUserId: "user_me",
        legacyActiveShare: null,
        pathname: "/project",
        routeProjectPath: share.projectRoot,
      }),
    ).toEqual(share);
  });

  // A named route that does not match must not fall through to any other
  // accepted share.
  it("resolves nothing when the named session belongs to no accepted share", () => {
    expect(
      resolveRouteShare({
        acceptedShares: [share],
        currentUserId: "user_me",
        legacyActiveShare: null,
        pathname: "/project",
        sessionId: "claude-someone-else",
      }),
    ).toBeNull();
  });
});
