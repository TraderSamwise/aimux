import { describe, expect, it } from "vitest";

import {
  COMPOSER_SEND_TIMEOUT_MESSAGE,
  formatComposerSendFailure,
  getComposerSendText,
  normalizeComposerDraft,
  userMessageAcknowledgesComposerSend,
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

  it("confirms sends against projected transcript text parts", () => {
    expect(
      userMessageAcknowledgesComposerSend(
        [
          { role: "user", parts: [{ type: "text", text: "older prompt" }] },
          { role: "assistant", parts: [{ type: "text", text: "answer" }] },
          {
            role: "user",
            parts: [{ type: "text", text: "Still scrolling down behind prompt box" }],
          },
        ],
        {
          attachmentFilenames: [],
          baselineUserMessageCount: 1,
          text: "Still scrolling down behind prompt box",
        },
      ),
    ).toBe(true);
  });

  it("does not confirm from old user messages before the send baseline", () => {
    expect(
      userMessageAcknowledgesComposerSend(
        [{ role: "user", parts: [{ type: "text", text: "same text" }] }],
        {
          attachmentFilenames: [],
          baselineUserMessageCount: 1,
          text: "same text",
        },
      ),
    ).toBe(false);
  });

  it("confirms attachment-only sends from projected attachment filenames", () => {
    expect(
      userMessageAcknowledgesComposerSend(
        [
          {
            role: "user",
            parts: [
              {
                type: "image_reference",
                label: "[image #1]",
                filename: "IMG_0400.png",
              },
            ],
          },
        ],
        {
          attachmentFilenames: ["IMG_0400.png"],
          baselineUserMessageCount: 0,
          text: "",
        },
      ),
    ).toBe(true);
  });

  it("confirms queue-up sends with both text and image parts", () => {
    expect(
      userMessageAcknowledgesComposerSend(
        [
          {
            role: "user",
            parts: [
              { type: "text", text: "Queue up: msg echo ack needs to work" },
              { type: "image_reference", label: "[image #1]", filename: "IMG_0407.png" },
            ],
          },
        ],
        {
          attachmentFilenames: ["IMG_0407.png"],
          baselineUserMessageCount: 0,
          text: "Queue up: msg echo ack needs to work",
        },
      ),
    ).toBe(true);
  });
});
