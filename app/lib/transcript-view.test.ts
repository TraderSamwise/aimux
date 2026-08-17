import { describe, expect, it } from "vitest";

import { serviceProjectsTranscript, toChatMessages } from "./transcript-view";

const message = (over: Partial<Parameters<typeof toChatMessages>[0][number]> = {}) => ({
  id: "assistant:abc123def456",
  role: "assistant" as const,
  parts: [{ type: "text" as const, text: "hello" }],
  text: "hello",
  ...over,
});

describe("toChatMessages", () => {
  it("keys a settled message by its content id", () => {
    const [chat] = toChatMessages([message()], "codex-1");
    expect(chat!.id).toBe("assistant:abc123def456");
  });

  it("keys the newest message by position, so writing into it does not remount", () => {
    const [chat] = toChatMessages([message({ latest: true })], "codex-1");
    expect(chat!.id).toBe("codex-1:latest");
  });

  it("builds the attachment url the client can actually reach", () => {
    const [chat] = toChatMessages(
      [
        message({
          parts: [{ type: "image_reference", label: "[image #1]", attachmentId: "att_a1" }],
        }),
      ],
      "codex-1",
    );

    expect(chat!.parts![0]).toMatchObject({
      attachmentId: "att_a1",
      contentUrl: "/attachments/att_a1/content?sessionId=codex-1",
    });
  });

  it("preserves service-provided hosted attachment urls", () => {
    const [chat] = toChatMessages(
      [
        message({
          parts: [
            {
              type: "image_reference",
              label: "[image #1]",
              attachmentId: "att_a1",
              contentUrl: "https://relay.aimux.app/attachments/hosted/ha_123/content",
            },
          ],
        }),
      ],
      "codex-1",
    );

    expect(chat!.parts![0]).toMatchObject({
      attachmentId: "att_a1",
      contentUrl: "https://relay.aimux.app/attachments/hosted/ha_123/content",
    });
  });

  it("builds generic attachment urls", () => {
    const [chat] = toChatMessages(
      [
        message({
          parts: [
            {
              type: "attachment_reference",
              label: "[file #1]",
              attachmentId: "att_pdf",
              filename: "notes.pdf",
              mimeType: "application/pdf",
              kind: "pdf",
            },
          ],
        }),
      ],
      "codex-1",
    );

    expect(chat!.parts![0]).toMatchObject({
      type: "attachment_reference",
      attachmentId: "att_pdf",
      contentUrl: "/attachments/att_pdf/content?sessionId=codex-1",
    });
  });

  it("upgrades structured image attachments that arrived as generic file refs", () => {
    const [chat] = toChatMessages(
      [
        message({
          role: "user",
          parts: [
            {
              type: "attachment_reference",
              label: "[file #1]",
              attachmentId: "att_image",
              filename: "Screenshot 2026-08-17.png",
              mimeType: "image/png",
              kind: "file",
            },
          ],
        }),
      ],
      "codex-1",
    );

    expect(chat!.parts).toEqual([
      {
        type: "image_reference",
        label: "[image #1]",
        attachmentId: "att_image",
        filename: "Screenshot 2026-08-17.png",
        mimeType: "image/png",
        contentUrl: "/attachments/att_image/content?sessionId=codex-1",
        hostedExpiresAt: undefined,
      },
    ]);
  });

  it("infers an image attachment from the filename when older events omit the mime type", () => {
    const [chat] = toChatMessages(
      [
        message({
          role: "user",
          parts: [
            {
              type: "attachment_reference",
              label: "[file #1]",
              attachmentId: "att_old_image",
              filename: "mockup.webp",
              kind: "file",
            },
          ],
        }),
      ],
      "codex-1",
    );

    expect(chat!.parts![0]).toMatchObject({
      type: "image_reference",
      label: "[image #1]",
      attachmentId: "att_old_image",
      filename: "mockup.webp",
    });
  });

  it("upgrades legacy generic screenshot text into an inline image", () => {
    const [chat] = toChatMessages(
      [
        message({
          role: "user",
          parts: [
            {
              type: "text",
              text:
                "Queue this up Attached files: - Screenshot 2026-08-15 at 7.17.12 PM.png " +
                "(image/png, 330511 bytes): /Users/sam/cs/aimux/.aimux/attachments/att_65a4b09dede14f52955c389683f3a3e5.png",
            },
          ],
        }),
      ],
      "codex-1",
    );

    expect(chat!.parts).toEqual([
      { type: "text", text: "Queue this up" },
      {
        type: "image_reference",
        label: "[image #1]",
        attachmentId: "att_65a4b09dede14f52955c389683f3a3e5",
        filename: "Screenshot 2026-08-15 at 7.17.12 PM.png",
        mimeType: "image/png",
        contentUrl: "/attachments/att_65a4b09dede14f52955c389683f3a3e5/content?sessionId=codex-1",
      },
    ]);
    expect(JSON.stringify(chat)).not.toContain("/Users/sam/cs/aimux/.aimux/attachments");
  });

  it("recovers wrapped legacy image attachment paths", () => {
    const [chat] = toChatMessages(
      [
        message({
          role: "user",
          parts: [
            {
              type: "text",
              text:
                "Mobile expose titles still 2 rows. Attached image files: - IMG_0309.png " +
                "(image/png, 267021 bytes): /Users/sam/cs/aimux/.aimux/attachments/\n" +
                "att_bb2103cedb1e496b992f21ab5d341d9e.png",
            },
          ],
        }),
      ],
      "codex-1",
    );

    expect(chat!.parts).toEqual([
      {
        type: "text",
        text: "Mobile expose titles still 2 rows.",
      },
      {
        type: "image_reference",
        label: "[image #1]",
        attachmentId: "att_bb2103cedb1e496b992f21ab5d341d9e",
        filename: "IMG_0309.png",
        mimeType: "image/png",
        contentUrl: "/attachments/att_bb2103cedb1e496b992f21ab5d341d9e/content?sessionId=codex-1",
      },
    ]);
    expect(JSON.stringify(chat)).not.toContain("/Users/sam/cs/aimux/.aimux/attachments");
  });

  it("escapes a session id rather than pasting it into the query", () => {
    const [chat] = toChatMessages(
      [message({ parts: [{ type: "image_reference", label: "x", attachmentId: "att_a" }] })],
      "a b&c",
    );
    expect((chat!.parts![0] as { contentUrl: string }).contentUrl).toContain("sessionId=a%20b%26c");
  });

  it("leaves text parts alone", () => {
    const [chat] = toChatMessages([message()], "codex-1");
    expect(chat!.parts).toEqual([{ type: "text", text: "hello" }]);
  });

  it("normalizes legacy shared prompts for shared chat display", () => {
    const [spaced, inline] = toChatMessages(
      [
        message({
          role: "user",
          parts: [
            { type: "text", text: "Message from Sam Owner via Aimux shared chat:\n\nowner shared" },
          ],
        }),
        message({
          role: "user",
          parts: [{ type: "text", text: "Message from Ada Guest via Aimux shared chat: hello" }],
        }),
      ],
      "codex-1",
      { shared: true },
    );

    expect(spaced!.parts).toEqual([{ type: "text", text: "[Sam Owner] owner shared" }]);
    expect(inline!.parts).toEqual([{ type: "text", text: "[Ada Guest] hello" }]);
  });

  it("leaves bracketed shared prompts and assistant messages alone", () => {
    const [user, assistant] = toChatMessages(
      [
        message({ role: "user", parts: [{ type: "text", text: "[Ada Guest] hello from share" }] }),
        message({
          role: "assistant",
          parts: [
            {
              type: "text",
              text: "Message from Ada Guest via Aimux shared chat:\n\nhello from share",
            },
          ],
        }),
      ],
      "codex-1",
      { shared: true },
    );

    expect(user!.parts).toEqual([{ type: "text", text: "[Ada Guest] hello from share" }]);
    expect(assistant!.parts).toEqual([
      { type: "text", text: "Message from Ada Guest via Aimux shared chat:\n\nhello from share" },
    ]);
  });
});

describe("serviceProjectsTranscript", () => {
  it("tells an empty pane apart from a service that does not project one", () => {
    expect(serviceProjectsTranscript([])).toBe(true);
    expect(serviceProjectsTranscript(undefined)).toBe(false);
  });
});
