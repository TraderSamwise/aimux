import { describe, expect, it } from "vitest";

import type { ParsedAgentOutput } from "./events";
import { messagesFromParsedAgentOutput } from "./parsed-transcript";
import { parseAgentOutput } from "../../src/agent-output-parser.js";
import { getParserFixture } from "../../src/agent-output-parser-test-utils.js";

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

  it("does not render mined Codex startup suggestions as chat messages", () => {
    const messages = messagesFromFixture("codex-live-startup-suggestion-loop");

    expect(messages).toEqual([]);
  });

  it("does not render mined Codex running-state suggestions as chat messages", () => {
    const messages = messagesFromFixture("codex-active-image-input-followed-by-suggestion");

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.parts).toEqual([
      { type: "text", text: "can you see this?" },
      {
        type: "image_reference",
        label: "[image #1]",
        attachmentId: "att_example",
        filename: "Screenshot.png",
        mimeType: "image/png",
        contentUrl: "/attachments/att_example/content",
      },
    ]);
    expect(JSON.stringify(messages)).not.toContain("Explain this codebase");
  });

  it("does not render mined Claude tool action rows as chat messages", () => {
    const messages = messagesFromFixture("claude-live-tool-action-rows");

    expect(messages.map((message) => messageTextForTest(message))).toEqual([
      "Good question. Let me check the relay status.",
      "All checks are green. I can merge now.",
    ]);
    expect(JSON.stringify(messages)).not.toContain("Bash(cd");
    expect(JSON.stringify(messages)).not.toContain("Read 2 files");
    expect(JSON.stringify(messages)).not.toContain("Update(src/relay.ts)");
  });

  it("does not render malformed Claude animation captures as chat messages", () => {
    expect(messagesFromFixture("claude-malformed-animation-status")).toEqual([]);
  });

  it("does not render collapsed Claude approval captures as chat messages", () => {
    expect(messagesFromFixture("claude-collapsed-approval-status")).toEqual([]);
  });
});

function messagesFromFixture(name: string) {
  const fixture = getParserFixture(name);
  return messagesFromParsedAgentOutput(
    parseAgentOutput(fixture.raw, { tool: fixture.tool }) as unknown as ParsedAgentOutput,
  );
}

function messageTextForTest(
  message: ReturnType<typeof messagesFromParsedAgentOutput>[number],
): string {
  return (message.parts ?? [])
    .filter(
      (part): part is Extract<NonNullable<typeof message.parts>[number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}
