import { describe, expect, it } from "vitest";
import type { AttachmentRecord } from "../attachment-store.js";
import {
  bodySharedChatActor,
  formatAgentInputWithAttachments,
  formatSharedChatAgentInput,
  hostedAttachmentFromBody,
  safeSharedChatActorName,
} from "./agent-input.js";

function attachment(overrides: Partial<AttachmentRecord> = {}): AttachmentRecord {
  return {
    id: "att-1",
    kind: "image",
    filename: "photo.png",
    mimeType: "image/png",
    sizeBytes: 123,
    sha256: "abc",
    createdAt: "2026-01-01T00:00:00.000Z",
    source: "upload",
    contentPath: "/tmp/photo.png",
    sessionId: "codex-1",
    ...overrides,
  };
}

describe("metadata server agent input helpers", () => {
  it("parses shared chat actors from request bodies", () => {
    expect(
      bodySharedChatActor({
        sharedChatActor: {
          role: "guest",
          displayName: "  Sam   Wise  ",
          email: "sam@example.com",
        },
      }),
    ).toEqual({ role: "guest", displayName: "Sam   Wise", email: "sam@example.com" });

    expect(bodySharedChatActor({ sharedChatActor: { role: "admin", displayName: "Sam" } })).toBeNull();
    expect(bodySharedChatActor({ sharedChatActor: { role: "owner" } })).toBeNull();
  });

  it("formats shared chat input with a bounded actor prefix", () => {
    expect(formatSharedChatAgentInput("  hello  ", { role: "owner", displayName: " Sam\nWise " })).toBe(
      "[Sam Wise] hello",
    );
    expect(safeSharedChatActorName({ role: "guest", displayName: "x".repeat(100) })).toHaveLength(80);
    expect(formatSharedChatAgentInput("hello", { role: "guest" })).toBe("[shared guest] hello");
  });

  it("formats attachment references without changing input when none exist", () => {
    expect(formatAgentInputWithAttachments("  keep spacing  ", [])).toBe("  keep spacing  ");
    expect(formatAgentInputWithAttachments("", [attachment()])).toBe(
      "Please review the attached file(s).\n\nAttached files:\n- photo.png (image/png, 123 bytes): /tmp/photo.png",
    );
    expect(
      formatAgentInputWithAttachments("Review this", [attachment({ filename: "notes.md", mimeType: "text/markdown" })]),
    ).toBe("Review this\n\nAttached files:\n- notes.md (text/markdown, 123 bytes): /tmp/photo.png");
  });

  it("parses hosted attachment references from request bodies", () => {
    expect(
      hostedAttachmentFromBody({
        contentUrl: "https://example.com/a.png",
        expiresAt: "2026-01-01T01:00:00.000Z",
        sha256: "abc",
        sizeBytes: 123,
      }),
    ).toEqual({
      contentUrl: "https://example.com/a.png",
      expiresAt: "2026-01-01T01:00:00.000Z",
      sha256: "abc",
      sizeBytes: 123,
    });
    expect(hostedAttachmentFromBody({ contentUrl: "https://example.com/a.png" })).toBeUndefined();
  });
});
