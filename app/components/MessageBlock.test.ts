import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Image: "Image",
  Platform: { OS: "web" },
  Text: "Text",
  View: "View",
}));

import {
  canRenderRichText,
  messageSpeakerLabel,
  resolveImageUrl,
  shouldRenderRichTerminalText,
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
