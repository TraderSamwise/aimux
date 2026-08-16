import { describe, expect, it } from "vitest";

import {
  COMPOSER_SEND_TIMEOUT_MESSAGE,
  formatComposerSendFailure,
  getComposerSendText,
  normalizeComposerDraft,
  shouldSubmitComposerKey,
} from "@/lib/composer-protocol";

describe("composer protocol", () => {
  it("normalizes message drafts before submit", () => {
    expect(normalizeComposerDraft("  hello\n")).toBe("hello");
    expect(normalizeComposerDraft("  \n\t")).toBeNull();
  });

  it("submits plain Enter and preserves modified Enter keypresses", () => {
    expect(shouldSubmitComposerKey({ key: "Enter" })).toBe(true);
    expect(shouldSubmitComposerKey({ key: "Enter", shiftKey: true })).toBe(false);
    expect(shouldSubmitComposerKey({ key: "Enter", ctrlKey: true })).toBe(false);
    expect(shouldSubmitComposerKey({ key: "Enter", metaKey: true })).toBe(false);
    expect(shouldSubmitComposerKey({ key: "Enter", altKey: true })).toBe(false);
    expect(shouldSubmitComposerKey({ key: "a" })).toBe(false);
  });

  it("blocks sends without a target or while a send is in flight", () => {
    expect(
      getComposerSendText({
        draft: "hello",
        hasServiceEndpoint: true,
        hasSessionId: true,
        sendBusy: false,
      }),
    ).toBe("hello");
    expect(
      getComposerSendText({
        draft: "hello",
        hasServiceEndpoint: false,
        hasSessionId: true,
        sendBusy: false,
      }),
    ).toBeNull();
    expect(
      getComposerSendText({
        draft: "hello",
        hasServiceEndpoint: true,
        hasSessionId: false,
        sendBusy: false,
      }),
    ).toBeNull();
    expect(
      getComposerSendText({
        draft: "hello",
        hasServiceEndpoint: true,
        hasSessionId: true,
        sendBusy: true,
      }),
    ).toBeNull();
  });

  it("formats send failure states for the composer", () => {
    expect(COMPOSER_SEND_TIMEOUT_MESSAGE).toContain("not confirmed");
    expect(formatComposerSendFailure(new Error("offline"))).toBe("Send failed: offline");
    expect(formatComposerSendFailure("network down")).toBe("Send failed: network down");
    expect(formatComposerSendFailure("")).toBe("Send failed. Check connection and retry.");
    expect(formatComposerSendFailure(undefined)).toBe("Send failed. Check connection and retry.");
  });
});
