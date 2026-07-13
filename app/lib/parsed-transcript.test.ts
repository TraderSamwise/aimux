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

  it("replaces multiple flattened user attachments with image references", () => {
    const messages = messagesFromParsedAgentOutput({
      blocks: [
        {
          type: "prompt",
          text:
            "Compare these Attached image files: " +
            "- first.png (image/png, 68 bytes): /Users/sam/cs/app/.aimux/attachments/att_first123.png " +
            "- second.jpeg (image/jpeg, 128 bytes): /Users/sam/cs/app/.aimux/attachments/att_second456.jpg",
        },
      ],
    });

    expect(messages).toEqual([
      {
        id: "parsed-0-prompt",
        role: "user",
        parts: [
          { type: "text", text: "Compare these" },
          {
            type: "image_reference",
            label: "[image #1]",
            attachmentId: "att_first123",
            filename: "first.png",
            mimeType: "image/png",
            contentUrl: "/attachments/att_first123/content",
          },
          {
            type: "image_reference",
            label: "[image #2]",
            attachmentId: "att_second456",
            filename: "second.jpeg",
            mimeType: "image/jpeg",
            contentUrl: "/attachments/att_second456/content",
          },
        ],
      },
    ]);
  });

  it("replaces terminal-wrapped flattened attachment metadata with numbered image references", () => {
    const messages = messagesFromParsedAgentOutput({
      blocks: [
        {
          type: "prompt",
          text:
            "AIMUX_IMAGE_SMOKE_FIXED_1783934800: confirm attached filename then reply\n" +
            "  IMAGE_FIXED_OK_1783934800. Attached image files: - aimux-smoke-1x1-fixed.png (image/png, 68\n" +
            "  bytes):\n" +
            "  /Users/sam/cs/tealstreet-mobile/.aimux/attachments/att_e831342aad14415cb0a8856fb93879fa.png",
        },
      ],
    });

    expect(messages).toEqual([
      {
        id: "parsed-0-prompt",
        role: "user",
        parts: [
          {
            type: "text",
            text: "AIMUX_IMAGE_SMOKE_FIXED_1783934800: confirm attached filename then reply IMAGE_FIXED_OK_1783934800.",
          },
          {
            type: "image_reference",
            label: "[image #1]",
            attachmentId: "att_e831342aad14415cb0a8856fb93879fa",
            filename: "aimux-smoke-1x1-fixed.png",
            mimeType: "image/png",
            contentUrl: "/attachments/att_e831342aad14415cb0a8856fb93879fa/content",
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

  it("does not render current Codex startup warnings as chat messages", () => {
    const raw = [
      "⚠ `--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this",
      "  invocation.",
      "",
      "╭──────────────────────────────────────────────╮",
      "│ >_ OpenAI Codex (v0.144.1)                   │",
      "│                                              │",
      "│ model:       gpt-5.5 high   /model to change │",
      "│ directory:   ~/cs/tealstreet-mobile          │",
      "│ permissions: YOLO mode                       │",
      "╰──────────────────────────────────────────────╯",
      "",
      "  Tip: New Use /fast to enable our fastest inference with increased plan usage.",
      "",
      "• You have 3 usage limit resets available. Run /usage to use one.",
      "",
      "⚠ `--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this",
      "  invocation.",
      "",
      "› Implement {feature}",
      "",
      "  gpt-5.5 high · ~/cs/tealstreet-mobile",
    ].join("\n");

    const messages = messagesFromParsedAgentOutput(
      parseAgentOutput(raw, { tool: "codex" }) as unknown as ParsedAgentOutput,
    );

    expect(messages).toEqual([]);
  });

  it("does not render Claude startup promo announcements as chat messages", () => {
    const raw = [
      "▘▘ ▝▝    ~/cs/tealstreet-mobile",
      "",
      "▎ weekly rate limits 50% higher, through July 19.",
      "▎",
      "▎ As before, you can use up to half of your weekly usage limit on Fable 5. After that, you can",
      "▎ keep using Fable 5 with usage credits, or switch to another model to keep working within your",
      "▎ remaining limits.",
      "▎",
      "▎ More details here:",
      "▎ https://support.claude.com/en/articles/15424964-claude-fable-5-promotional-access",
      "",
      "❯ AIMUX_GUI_CLAUDE_T1_1783935900: reply exactly CLAUDE_T1_OK_1783935900",
      "",
      "⏺ CLAUDE_T1_OK_1783935900",
    ].join("\n");

    const messages = messagesFromParsedAgentOutput(
      parseAgentOutput(raw, { tool: "claude" }) as unknown as ParsedAgentOutput,
    );

    expect(messages.map((message) => messageTextForTest(message))).toEqual([
      "AIMUX_GUI_CLAUDE_T1_1783935900: reply exactly CLAUDE_T1_OK_1783935900",
      "CLAUDE_T1_OK_1783935900",
    ]);
  });

  it("does not render Claude skill availability rows in user messages", () => {
    const raw = [
      "❯ AIMUX_GUI_CLAUDE_POST_PROMO_FIX_1783952300: reply exactly CLAUDE_POST_PROMO_FIX_OK_1783952300",
      "  and include one bullet named promo-filter.",
      "  ⎿  1 skill available",
      "",
      "⏺ CLAUDE_POST_PROMO_FIX_OK_1783952300",
      "",
      "  - promo-filter",
    ].join("\n");

    const messages = messagesFromParsedAgentOutput(
      parseAgentOutput(raw, { tool: "claude" }) as unknown as ParsedAgentOutput,
    );

    expect(messages.map((message) => messageTextForTest(message))).toEqual([
      "AIMUX_GUI_CLAUDE_POST_PROMO_FIX_1783952300: reply exactly CLAUDE_POST_PROMO_FIX_OK_1783952300\n" +
        "  and include one bullet named promo-filter.",
      "CLAUDE_POST_PROMO_FIX_OK_1783952300\n\n  - promo-filter",
    ]);
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
