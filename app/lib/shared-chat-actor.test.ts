import { describe, expect, it } from "vitest";
import type { ShareParticipant } from "@/lib/api";
import { resolveSharedChatActor } from "./shared-chat-actor";

const owner: ShareParticipant = {
  userId: "user_owner",
  displayName: "Sam Owner",
  email: "sam@example.com",
  role: "owner",
  status: "active",
  joinedAt: "2026-08-13T00:00:00.000Z",
};

const guest: ShareParticipant = {
  userId: "user_guest",
  displayName: "Ada Guest",
  email: "ada@example.com",
  role: "guest",
  status: "active",
  joinedAt: "2026-08-13T00:00:00.000Z",
};

describe("resolveSharedChatActor", () => {
  it("does not tag non-shared conversations", () => {
    expect(
      resolveSharedChatActor({
        isCanonicalSharedRoute: false,
        isSharedConversation: false,
      }),
    ).toBeUndefined();
  });

  it("tags owners correctly in the shared experience", () => {
    expect(
      resolveSharedChatActor({
        currentParticipant: owner,
        isCanonicalSharedRoute: true,
        isSharedConversation: true,
        routeOwnerUserId: owner.userId,
        userId: owner.userId,
      }),
    ).toEqual({
      role: "owner",
      displayName: "Sam Owner",
      email: "sam@example.com",
    });
  });

  it("tags guests correctly in the shared experience", () => {
    expect(
      resolveSharedChatActor({
        currentParticipant: guest,
        isCanonicalSharedRoute: true,
        isSharedConversation: true,
        routeOwnerUserId: owner.userId,
        userId: guest.userId,
      }),
    ).toEqual({
      role: "guest",
      displayName: "Ada Guest",
      email: "ada@example.com",
    });
  });

  it("still tags owner GUI messages from normal project routes", () => {
    expect(
      resolveSharedChatActor({
        currentParticipant: owner,
        displayName: "Fallback Name",
        email: "fallback@example.com",
        isCanonicalSharedRoute: false,
        isSharedConversation: true,
        userId: owner.userId,
      }),
    ).toEqual({
      role: "owner",
      displayName: "Sam Owner",
      email: "sam@example.com",
    });
  });
});
