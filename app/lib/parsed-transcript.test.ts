import { describe, expect, it } from "vitest";

import { messagesFromParsedAgentOutput } from "@/lib/parsed-transcript";

describe("parsed transcript conversion", () => {
  it("turns parsed prompt and response blocks into ordered chat messages", () => {
    const messages = messagesFromParsedAgentOutput({
      blocks: [
        { type: "meta", text: "Claude Code" },
        { type: "prompt", text: "hi" },
        { type: "response", text: "Hello there" },
        { type: "status", text: "ready" },
        { type: "prompt", text: "write me a poem" },
        { type: "response", text: "Roses compile\nTests are green" },
      ],
    });

    expect(messages).toEqual([
      {
        id: "parsed-1-prompt",
        role: "user",
        parts: [{ type: "text", text: "hi" }],
      },
      {
        id: "parsed-2-response",
        role: "assistant",
        parts: [{ type: "text", text: "Hello there" }],
      },
      {
        id: "parsed-4-prompt",
        role: "user",
        parts: [{ type: "text", text: "write me a poem" }],
      },
      {
        id: "parsed-5-response",
        role: "assistant",
        parts: [{ type: "text", text: "Roses compile\nTests are green" }],
      },
    ]);
  });

  it("accepts kind-based prompt and response blocks", () => {
    const messages = messagesFromParsedAgentOutput({
      blocks: [
        { kind: "prompt", text: "legacy hello" },
        { type: "response", text: "modern reply" },
        { kind: "response", text: "legacy reply" },
      ],
    });

    expect(messages).toEqual([
      {
        id: "parsed-0-prompt",
        role: "user",
        parts: [{ type: "text", text: "legacy hello" }],
      },
      {
        id: "parsed-1-response",
        role: "assistant",
        parts: [{ type: "text", text: "modern reply" }],
      },
      {
        id: "parsed-2-response",
        role: "assistant",
        parts: [{ type: "text", text: "legacy reply" }],
      },
    ]);
  });

  it("replaces user attachment metadata with numbered image references", () => {
    const messages = messagesFromParsedAgentOutput({
      blocks: [
        {
          type: "prompt",
          text:
            "Describe this image\n\n" +
            "Attached image files:\n" +
            "- IMG_0002.jpeg (image/jpeg, 2567402 bytes): /Users/sam/cs/glyde-frontend/.aimux/attachments/att_bb092916164a4cbba1530b79a12980e2.jpg",
        },
      ],
    });

    expect(messages).toEqual([
      {
        id: "parsed-0-prompt",
        role: "user",
        parts: [
          { type: "text", text: "Describe this image" },
          {
            type: "image_reference",
            label: "[image #1]",
            attachmentId: "att_bb092916164a4cbba1530b79a12980e2",
            filename: "IMG_0002.jpeg",
            mimeType: "image/jpeg",
            contentUrl: "/attachments/att_bb092916164a4cbba1530b79a12980e2/content",
          },
        ],
      },
    ]);
  });

  it("replaces flattened user attachment metadata with numbered image references", () => {
    const messages = messagesFromParsedAgentOutput({
      blocks: [
        {
          type: "prompt",
          text: "Describe this image Attached image files: - IMG_0002.jpeg (image/jpeg, 2567402 bytes): /Users/sam/cs/glyde-frontend/.aimux/attachments/att_bb092916164a4cbba1530b79a12980e2.jpg",
        },
      ],
    });

    expect(messages).toEqual([
      {
        id: "parsed-0-prompt",
        role: "user",
        parts: [
          { type: "text", text: "Describe this image" },
          {
            type: "image_reference",
            label: "[image #1]",
            attachmentId: "att_bb092916164a4cbba1530b79a12980e2",
            filename: "IMG_0002.jpeg",
            mimeType: "image/jpeg",
            contentUrl: "/attachments/att_bb092916164a4cbba1530b79a12980e2/content",
          },
        ],
      },
    ]);
  });

  it("uses stable image reference numbers across user and assistant transcript blocks", () => {
    const messages = messagesFromParsedAgentOutput({
      blocks: [
        {
          type: "prompt",
          text:
            "Describe this image\n\n" +
            "Attached image files:\n" +
            "- IMG_0002.jpeg (image/jpeg, 2567402 bytes): /Users/sam/cs/glyde-frontend/.aimux/attachments/att_bb092916164a4cbba1530b79a12980e2.jpg",
        },
        {
          type: "response",
          text:
            "Viewed Image\n" +
            "└ .aimux/attachments/att_bb092916164a4cbba1530b79a12980e2.jpg\n\n" +
            "A close-up photo of leafy green plant branches.",
        },
        {
          type: "prompt",
          text:
            "What about this one?\n\n" +
            "Attached image files:\n" +
            "- IMG_0005.jpeg (image/jpeg, 1484524 bytes): /Users/sam/cs/glyde-frontend/.aimux/attachments/att_fab7657c43ba431f90a6fe0ce04cf18e.jpg",
        },
      ],
    });

    expect(messages.map((message) => message.parts)).toEqual([
      [
        { type: "text", text: "Describe this image" },
        {
          type: "image_reference",
          label: "[image #1]",
          attachmentId: "att_bb092916164a4cbba1530b79a12980e2",
          filename: "IMG_0002.jpeg",
          mimeType: "image/jpeg",
          contentUrl: "/attachments/att_bb092916164a4cbba1530b79a12980e2/content",
        },
      ],
      [
        {
          type: "image_reference",
          label: "[image #1]",
          attachmentId: "att_bb092916164a4cbba1530b79a12980e2",
          filename: undefined,
          mimeType: undefined,
          contentUrl: "/attachments/att_bb092916164a4cbba1530b79a12980e2/content",
        },
        { type: "text", text: "A close-up photo of leafy green plant branches." },
      ],
      [
        { type: "text", text: "What about this one?" },
        {
          type: "image_reference",
          label: "[image #2]",
          attachmentId: "att_fab7657c43ba431f90a6fe0ce04cf18e",
          filename: "IMG_0005.jpeg",
          mimeType: "image/jpeg",
          contentUrl: "/attachments/att_fab7657c43ba431f90a6fe0ce04cf18e/content",
        },
      ],
    ]);
  });
});
