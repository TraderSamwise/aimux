import { describe, expect, it } from "vitest";

import { applyAgentCollaborationPrefix, collaborationContextFromHeaders } from "./collaboration.js";

describe("collaboration context", () => {
  it("parses relay-injected actor headers", () => {
    expect(
      collaborationContextFromHeaders({
        "x-aimux-share-id": "share_123",
        "x-aimux-share-mode": "multi",
        "x-aimux-actor-user-id": "user_123",
        "x-aimux-actor-name": "Sam Steady",
        "x-aimux-actor-email": "sam@example.com",
        "x-aimux-actor-role": "owner",
      }),
    ).toEqual({
      shareId: "share_123",
      mode: "multi",
      actor: {
        userId: "user_123",
        displayName: "Sam Steady",
        email: "sam@example.com",
        role: "owner",
      },
    });
  });

  it("returns undefined when no collaboration headers are present", () => {
    expect(collaborationContextFromHeaders({ "content-type": "application/json" })).toBeUndefined();
  });

  it("prefixes plain text input only in multi-user mode", () => {
    const collaboration = {
      shareId: "share_123",
      mode: "multi" as const,
      actor: { userId: "user_123", displayName: "Sam Steady" },
    };

    expect(applyAgentCollaborationPrefix({ data: "ship it" }, collaboration)).toEqual({
      data: "[Sam Steady]: ship it",
      parts: undefined,
    });
    expect(applyAgentCollaborationPrefix({ data: "ship it" }, { ...collaboration, mode: "single" })).toEqual({
      data: "ship it",
    });
  });

  it("prefixes the first text part without mutating image parts", () => {
    const input = {
      parts: [
        { type: "image" as const, attachmentId: "att_1", alt: "screenshot" },
        { type: "text" as const, text: "look here" },
      ],
    };

    expect(
      applyAgentCollaborationPrefix(input, {
        mode: "multi",
        actor: { userId: "user_123", displayName: "Casey" },
      }),
    ).toEqual({
      parts: [
        { type: "image", attachmentId: "att_1", alt: "screenshot" },
        { type: "text", text: "[Casey]: look here" },
      ],
    });
  });

  it("adds a speaker-only text part before image-only input", () => {
    expect(
      applyAgentCollaborationPrefix(
        { parts: [{ type: "image", attachmentId: "att_1" }] },
        {
          mode: "multi",
          actor: { userId: "user_123", displayName: "Casey" },
        },
      ),
    ).toEqual({
      data: undefined,
      parts: [
        { type: "text", text: "[Casey]:" },
        { type: "image", attachmentId: "att_1" },
      ],
    });
  });
});
