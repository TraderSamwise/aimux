import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Image: "Image",
  Linking: { openURL: vi.fn() },
  Platform: { OS: "web" },
  ScrollView: "ScrollView",
  Text: "Text",
  View: "View",
}));

import {
  canRenderRichText,
  displayableMessageParts,
  hasDisplayableChatMessageContent,
  hasDisplayableChatText,
  messageContainerStyleForRole,
  messageSpeakerLabel,
  normalizeChatLinkTarget,
  resolveImageUrl,
  shouldRenderRichTerminalText,
  splitChatTextLinkSegments,
  splitMarkdownTableSegments,
  splitMessageTextSegments,
} from "@/components/MessageBlock";

const endpoint = { host: "127.0.0.1", port: 43210 };
const originalConnectionMode = process.env.EXPO_PUBLIC_AIMUX_CONNECTION_MODE;
const originalRelayUrl = process.env.EXPO_PUBLIC_AIMUX_RELAY_URL;

describe("MessageBlock image URLs", () => {
  afterEach(() => {
    if (originalConnectionMode === undefined) {
      delete process.env.EXPO_PUBLIC_AIMUX_CONNECTION_MODE;
    } else {
      process.env.EXPO_PUBLIC_AIMUX_CONNECTION_MODE = originalConnectionMode;
    }
    if (originalRelayUrl === undefined) {
      delete process.env.EXPO_PUBLIC_AIMUX_RELAY_URL;
    } else {
      process.env.EXPO_PUBLIC_AIMUX_RELAY_URL = originalRelayUrl;
    }
  });

  it("resolves relative image URLs through direct project HTTP in local mode", () => {
    process.env.EXPO_PUBLIC_AIMUX_CONNECTION_MODE = "local";

    expect(
      resolveImageUrl(
        { type: "image", attachmentId: "att_1", contentUrl: "/attachments/att_1/content" },
        endpoint,
      ),
    ).toBe("http://127.0.0.1:43210/attachments/att_1/content");
  });

  it("normalizes attachment content paths without a leading slash", () => {
    process.env.EXPO_PUBLIC_AIMUX_CONNECTION_MODE = "local";

    expect(
      resolveImageUrl(
        { type: "image", attachmentId: "att_1", contentUrl: "attachments/att_1/content" },
        endpoint,
      ),
    ).toBe("http://127.0.0.1:43210/attachments/att_1/content");
  });

  it("resolves generic attachment reference URLs through direct project HTTP", () => {
    process.env.EXPO_PUBLIC_AIMUX_CONNECTION_MODE = "local";

    expect(
      resolveImageUrl(
        {
          type: "attachment_reference",
          attachmentId: "att_pdf",
          contentUrl: "/attachments/att_pdf/content",
          filename: "brief.pdf",
          kind: "pdf",
          label: "[file #1]",
          mimeType: "application/pdf",
        },
        endpoint,
      ),
    ).toBe("http://127.0.0.1:43210/attachments/att_pdf/content");
  });

  it("resolves relative image URLs through the relay proxy in relay mode", () => {
    process.env.EXPO_PUBLIC_AIMUX_CONNECTION_MODE = "relay";
    process.env.EXPO_PUBLIC_AIMUX_RELAY_URL = "wss://relay.example.test";

    expect(
      resolveImageUrl(
        { type: "image", attachmentId: "att_1", contentUrl: "/attachments/att_1/content" },
        endpoint,
      ),
    ).toBe("https://relay.example.test/proxy/127.0.0.1/43210/attachments/att_1/content");
  });

  it("preserves absolute image URLs in relay mode", () => {
    process.env.EXPO_PUBLIC_AIMUX_CONNECTION_MODE = "relay";

    expect(
      resolveImageUrl(
        { type: "image", attachmentId: "att_1", contentUrl: "https://example.test/shot.png" },
        endpoint,
      ),
    ).toBe("https://example.test/shot.png");
  });

  it("prefers hosted image URLs over local attachment URLs in relay mode", () => {
    process.env.EXPO_PUBLIC_AIMUX_CONNECTION_MODE = "relay";
    process.env.EXPO_PUBLIC_AIMUX_RELAY_URL = "wss://relay.example.test";

    expect(
      resolveImageUrl(
        {
          type: "image",
          attachmentId: "att_1",
          contentUrl: "/attachments/att_1/content?sessionId=codex-1",
          hostedContentUrl: "https://relay.example.test/attachments/hosted/ha_123/content",
        },
        endpoint,
      ),
    ).toBe("https://relay.example.test/attachments/hosted/ha_123/content");
  });

  it("prefers durable local attachment URLs over hosted URLs in local mode", () => {
    process.env.EXPO_PUBLIC_AIMUX_CONNECTION_MODE = "local";

    expect(
      resolveImageUrl(
        {
          type: "image",
          attachmentId: "att_1",
          contentUrl: "/attachments/att_1/content?sessionId=codex-1",
          hostedContentUrl: "https://relay.example.test/attachments/hosted/ha_123/content",
        },
        endpoint,
      ),
    ).toBe("http://127.0.0.1:43210/attachments/att_1/content?sessionId=codex-1");
  });

  it("omits images without a content URL", () => {
    process.env.EXPO_PUBLIC_AIMUX_CONNECTION_MODE = "local";

    expect(resolveImageUrl({ type: "image", attachmentId: "att_1" }, endpoint)).toBeNull();
  });
});

describe("MessageBlock speaker labels", () => {
  it("normalizes actor display names from shared chat history", () => {
    expect(
      messageSpeakerLabel({
        actor: {
          userId: "user_123",
          displayName: "  Sam   Steady  ",
          role: "owner",
        },
      }),
    ).toBe("Sam Steady");
  });

  it("omits labels when history has no actor metadata", () => {
    expect(messageSpeakerLabel({})).toBeNull();
  });
});

describe("MessageBlock rich text guard", () => {
  it("only renders rich spans when they exactly cover the text", () => {
    expect(canRenderRichText("red answer", [{ text: "red" }, { text: " answer" }])).toBe(true);
    expect(canRenderRichText("red answer", [{ text: "red" }])).toBe(false);
    expect(canRenderRichText("red answer", undefined)).toBe(false);
  });

  it("does not render terminal spans on user messages", () => {
    expect(
      shouldRenderRichTerminalText({
        isUser: true,
        enabled: true,
        text: "check again",
        spans: [{ text: "check again", background: { model: "rgb", value: "#ffffff" } }],
      }),
    ).toBe(false);
    expect(
      shouldRenderRichTerminalText({
        isUser: false,
        enabled: true,
        text: "Building",
        spans: [{ text: "Building", foreground: { model: "rgb", value: "#56b6c2" } }],
      }),
    ).toBe(true);
  });
});

describe("MessageBlock layout", () => {
  it("does not clip rich terminal spans inside chat bubbles", () => {
    expect(messageContainerStyleForRole("assistant").overflow).toBe("visible");
    expect(messageContainerStyleForRole("user").overflow).toBe("visible");
  });

  it("drops parser residue that has no displayable content", () => {
    expect(hasDisplayableChatText("\u200b\n\t")).toBe(false);
    expect(displayableMessageParts([{ type: "text", text: "\u200b\n" }])).toEqual([]);
    expect(
      hasDisplayableChatMessageContent({
        parts: [{ type: "text", text: "\u200b\n" }],
        text: "\u200b\n",
      }),
    ).toBe(false);
  });

  it("keeps attachment-only messages displayable", () => {
    expect(
      hasDisplayableChatMessageContent({
        parts: [
          {
            type: "image_reference",
            label: "[image #1]",
            attachmentId: "att_1",
            filename: "shot.png",
            mimeType: "image/png",
          },
        ],
        text: "",
      }),
    ).toBe(true);
  });
});

describe("MessageBlock links", () => {
  it("splits ordinary URLs into clickable link segments", () => {
    expect(splitChatTextLinkSegments("Open https://example.com/path?x=1.")).toEqual([
      { kind: "text", text: "Open " },
      { kind: "link", text: "https://example.com/path?x=1", url: "https://example.com/path?x=1" },
      { kind: "text", text: "." },
    ]);
  });

  it("turns Claude terminal artifact hyperlinks into clean link segments", () => {
    expect(
      splitChatTextLinkSegments(
        "]8;id=ub1ind;https://claude.ai/code/artifact/a77d\\Artifact page]8;;\\",
      ),
    ).toEqual([
      {
        kind: "link",
        text: "Artifact page",
        url: "https://claude.ai/code/artifact/a77d",
      },
    ]);
  });

  it("normalizes soft-wrapped link targets before opening", () => {
    expect(normalizeChatLinkTarget("https://example.com/a/\u200Bb")).toBe(
      "https://example.com/a/b",
    );
  });
});

describe("MessageBlock table text", () => {
  it("splits markdown tables into horizontally scrollable text segments", () => {
    expect(
      splitMarkdownTableSegments(
        [
          "Before",
          "",
          "| year | payouts | USDT |",
          "| --- | ---: | ---: |",
          "| 2023 | 239 | 3,027.30 |",
          "| 2024 | 215 | 51.31 |",
          "",
          "After",
        ].join("\n"),
      ),
    ).toEqual([
      { kind: "text", text: "Before" },
      {
        kind: "table",
        text: [
          "| year | payouts | USDT |",
          "| --- | ---: | ---: |",
          "| 2023 | 239 | 3,027.30 |",
          "| 2024 | 215 | 51.31 |",
        ].join("\n"),
      },
      { kind: "text", text: "After" },
    ]);
  });

  it("accepts markdown tables without outer pipes", () => {
    expect(
      splitMarkdownTableSegments(
        ["Account | Count | Total", "--- | ---: | ---:", "A | 2 | 10"].join("\n"),
      ),
    ).toEqual([
      {
        kind: "table",
        text: ["Account | Count | Total", "--- | ---: | ---:", "A | 2 | 10"].join("\n"),
      },
    ]);
  });

  it("splits terminal box tables into horizontally scrollable text segments", () => {
    expect(
      splitMarkdownTableSegments(
        [
          "Before",
          "",
          "╭──────────────┬────────╮",
          "│ Assignment   │ Status │",
          "├──────────────┼────────┤",
          "│ questionnaire│ done   │",
          "╰──────────────┴────────╯",
          "",
          "After",
        ].join("\n"),
      ),
    ).toEqual([
      { kind: "text", text: "Before" },
      {
        kind: "table",
        text: [
          "╭──────────────┬────────╮",
          "│ Assignment   │ Status │",
          "├──────────────┼────────┤",
          "│ questionnaire│ done   │",
          "╰──────────────┴────────╯",
        ].join("\n"),
      },
      { kind: "text", text: "After" },
    ]);
  });

  it("does not promote vertical-only box glyph output to a table", () => {
    expect(
      splitMarkdownTableSegments(
        [
          "299 +fn footer_hint_text(input:",
          "&DashboardRenderInput<'_>) -> String {",
          "300 +  if !input.snapshot.",
          "worktree_groups.is_empty() &&",
          "input.nav_level == DashboardNavLevel:",
          ":Worktrees {",
          '301 +    return "↑↓/jk worktrees [1-9]',
          "worktree [Enter/→/l] step in [Tab] details [n]",
          'agent [v] service [q] quit"',
          "302 +  }",
          "│││││  ││ ││││││││",
          "│││││  ││ ││││││││",
        ].join("\n"),
      ),
    ).toEqual([
      {
        kind: "text",
        text: [
          "299 +fn footer_hint_text(input:",
          "&DashboardRenderInput<'_>) -> String {",
          "300 +  if !input.snapshot.",
          "worktree_groups.is_empty() &&",
          "input.nav_level == DashboardNavLevel:",
          ":Worktrees {",
          '301 +    return "↑↓/jk worktrees [1-9]',
          "worktree [Enter/→/l] step in [Tab] details [n]",
          'agent [v] service [q] quit"',
          "302 +  }",
          "│││││  ││ ││││││││",
          "│││││  ││ ││││││││",
        ].join("\n"),
      },
    ]);
  });
});

describe("MessageBlock code edit previews", () => {
  it("splits Codex edit previews so only diff blocks can render smaller", () => {
    expect(
      splitMessageTextSegments(
        [
          "Before",
          "",
          "Edited app/lib/chat-scroll-model.ts (+7 -1)",
          "  1 export const DEFAULT_CHAT_SCROLL_END_THRESHOLD = 24;",
          "  2 +export const DEFAULT_CHAT_SCROLL_REANCHOR_THRESHOLD = 8;",
          "    SCROLL_REANCHOR_THRESHOLD = 8;",
          "",
          "After",
        ].join("\n"),
      ),
    ).toEqual([
      { kind: "text", text: "Before" },
      {
        kind: "code-edit-diff",
        text: [
          "Edited app/lib/chat-scroll-model.ts (+7 -1)",
          "  1 export const DEFAULT_CHAT_SCROLL_END_THRESHOLD = 24;",
          "  2 +export const DEFAULT_CHAT_SCROLL_REANCHOR_THRESHOLD = 8;",
          "    SCROLL_REANCHOR_THRESHOLD = 8;",
        ].join("\n"),
      },
      { kind: "text", text: "After" },
    ]);
  });

  it("does not treat ordinary colored tool text as code edit previews", () => {
    expect(splitMessageTextSegments("Bash(yarn test)\nRunning...")).toEqual([
      { kind: "text", text: "Bash(yarn test)\nRunning..." },
    ]);
  });
});
