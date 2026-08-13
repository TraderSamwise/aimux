import { describe, expect, it } from "vitest";

import {
  activeSessionsFromShareSummaries,
  mergeActiveSharedSessions,
  sharedSessionsEqual,
  shouldApplySharedSessionHydrate,
} from "./shared-sessions";

describe("shared session mapping", () => {
  it("maps relay summaries with service endpoints into active shared sessions", () => {
    expect(
      activeSessionsFromShareSummaries([
        {
          id: "share-1",
          ownerUserId: "owner-1",
          projectRoot: "/repo",
          sessionId: "claude-1",
          serviceEndpoint: { host: "127.0.0.1", port: 43192 },
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-02T00:00:00.000Z",
          version: 1,
          mode: "multi",
          participants: [],
          invites: [],
        },
        {
          id: "share-2",
          ownerUserId: "owner-1",
          projectRoot: "/repo",
          sessionId: "claude-2",
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-02T00:00:00.000Z",
          version: 1,
          mode: "multi",
          participants: [],
          invites: [],
        },
      ]),
    ).toEqual([
      {
        shareId: "share-1",
        ownerUserId: "owner-1",
        projectRoot: "/repo",
        sessionId: "claude-1",
        serviceEndpoint: { host: "127.0.0.1", port: 43192 },
        acceptedAt: "2026-08-02T00:00:00.000Z",
      },
    ]);
  });

  it("compares active shared sessions by value", () => {
    const share = {
      shareId: "share-1",
      ownerUserId: "owner-1",
      projectRoot: "/repo",
      sessionId: "claude-1",
      serviceEndpoint: { host: "127.0.0.1", port: 43192 },
      acceptedAt: "2026-08-02T00:00:00.000Z",
    };

    expect(
      sharedSessionsEqual([share], [{ ...share, serviceEndpoint: { ...share.serviceEndpoint } }]),
    ).toBe(true);
    expect(
      sharedSessionsEqual([share], [{ ...share, acceptedAt: "2026-08-03T00:00:00.000Z" }]),
    ).toBe(false);
  });

  it("merges an active shared session into displayed rows", () => {
    const older = {
      shareId: "share-old",
      ownerUserId: "owner-1",
      projectRoot: "/repo-old",
      sessionId: "claude-old",
      serviceEndpoint: { host: "127.0.0.1", port: 43192 },
      acceptedAt: "2026-08-01T00:00:00.000Z",
    };
    const active = {
      shareId: "share-active",
      ownerUserId: "owner-1",
      projectRoot: "/repo-active",
      sessionId: "claude-active",
      serviceEndpoint: { host: "127.0.0.1", port: 43192 },
      acceptedAt: "2026-08-03T00:00:00.000Z",
    };

    expect(mergeActiveSharedSessions([older], active)).toEqual([active, older]);
    expect(
      mergeActiveSharedSessions([active], { ...active, acceptedAt: active.acceptedAt }),
    ).toEqual([active]);
  });

  it("can keep cached shares for one transient empty hydrate", () => {
    const cached = {
      shareId: "share-1",
      ownerUserId: "owner-1",
      projectRoot: "/repo",
      sessionId: "claude-1",
      serviceEndpoint: { host: "127.0.0.1", port: 43192 },
      acceptedAt: "2026-08-02T00:00:00.000Z",
    };

    expect(shouldApplySharedSessionHydrate([cached], [], { preserveEmptyOnce: true })).toBe(false);
    expect(shouldApplySharedSessionHydrate([cached], [])).toBe(true);
    expect(shouldApplySharedSessionHydrate([], [])).toBe(true);
    expect(shouldApplySharedSessionHydrate([cached], [cached])).toBe(true);
  });
});
