import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Image: "Image",
  Platform: { OS: "web" },
  Text: "Text",
  View: "View",
}));

import { messageSpeakerLabel, resolveImageUrl } from "@/components/MessageBlock";

const endpoint = { host: "127.0.0.1", port: 43210 };
const originalConnectionMode = process.env.EXPO_PUBLIC_AIMUX_CONNECTION_MODE;

describe("MessageBlock image URLs", () => {
  afterEach(() => {
    if (originalConnectionMode === undefined) {
      delete process.env.EXPO_PUBLIC_AIMUX_CONNECTION_MODE;
    } else {
      process.env.EXPO_PUBLIC_AIMUX_CONNECTION_MODE = originalConnectionMode;
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

  it("does not synthesize direct project HTTP image URLs in relay mode", () => {
    process.env.EXPO_PUBLIC_AIMUX_CONNECTION_MODE = "relay";

    expect(
      resolveImageUrl(
        { type: "image", attachmentId: "att_1", contentUrl: "/attachments/att_1/content" },
        endpoint,
      ),
    ).toBeNull();
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
