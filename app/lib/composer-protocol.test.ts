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

  it("confirms long sends from a clipped echoed prefix", () => {
    const sentText =
      "There is a lot of work here. Please audit the routing layer, summarize the historical position, " +
      "then explain which fixes are already landed and which pieces are still failing in the mobile chat view. " +
      "Do not skip the edge cases around slow scrolling, prompt focus, and long visible user messages.";

    expect(
      userMessageAcknowledgesComposerSend(
        [
          {
            role: "user",
            parts: [
              {
                type: "text",
                text: sentText.slice(0, 150),
              },
            ],
          },
        ],
        {
          attachmentFilenames: [],
          baselineUserMessageCount: 0,
          text: sentText,
        },
      ),
    ).toBe(true);
  });

  it("confirms long sends from a visible middle fragment", () => {
    const sentText =
      "Start with the notification fanout and then continue into composer delivery. " +
      "The important point is that long prompt inputs can be visible only as one transcript fragment " +
      "while the full submitted prompt is larger than the current mobile capture window. " +
      "Finish by checking the ack state and do not leave the draft behind.";
    const middleFragment = "long prompt inputs can be visible only as one transcript fragment";

    expect(
      userMessageAcknowledgesComposerSend(
        [
          {
            role: "user",
            parts: [
              {
                type: "text",
                text: `... ${middleFragment} while the full submitted prompt is larger ...`,
              },
            ],
          },
        ],
        {
          attachmentFilenames: [],
          baselineUserMessageCount: 0,
          text: sentText,
        },
      ),
    ).toBe(true);
  });

  it("does not confirm short sends from partial echoed text", () => {
    expect(
      userMessageAcknowledgesComposerSend(
        [{ role: "user", parts: [{ type: "text", text: "please fix" }] }],
        {
          attachmentFilenames: [],
          baselineUserMessageCount: 0,
          text: "please fix the app",
        },
      ),
    ).toBe(false);
  });

  it("does not confirm long sends from unrelated new user text", () => {
    const sentText =
      "Investigate the long prompt delivery path across the app, metadata server, and tmux runtime. " +
      "The submitted text should clear only after the matching user echo appears in the structured chat transcript. " +
      "This sentence pads the request enough to require long-message matching behavior.";

    expect(
      userMessageAcknowledgesComposerSend(
        [
          {
            role: "user",
            parts: [
              {
                type: "text",
                text: "This is a different message that happens after the baseline but should not match.",
              },
            ],
          },
        ],
        {
          attachmentFilenames: [],
          baselineUserMessageCount: 0,
          text: sentText,
        },
      ),
    ).toBe(false);
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

  it("confirms attachment-only sends from projected attachment ids when filenames are absent", () => {
    expect(
      userMessageAcknowledgesComposerSend(
        [
          {
            role: "user",
            parts: [
              {
                type: "image_reference",
                label: "[image #1]",
                attachmentId: "att_screenshot",
              },
            ],
          },
        ],
        {
          attachmentIds: ["att_screenshot"],
          attachmentFilenames: ["IMG_0404.png"],
          baselineUserMessageCount: 0,
          text: "",
        },
      ),
    ).toBe(true);
  });

  it("does not confirm attachment-only sends from sparse image parts when pending metadata is known", () => {
    expect(
      userMessageAcknowledgesComposerSend(
        [
          {
            role: "user",
            parts: [
              {
                type: "image_reference",
                label: "[image #1]",
              },
            ],
          },
        ],
        {
          attachmentFilenames: ["IMG_0404.png"],
          baselineUserMessageCount: 0,
          text: "",
        },
      ),
    ).toBe(false);
  });

  it("confirms sparse attachment-only echoes only when pending metadata is unavailable", () => {
    expect(
      userMessageAcknowledgesComposerSend(
        [
          {
            role: "user",
            parts: [
              {
                type: "image_reference",
                label: "[image #1]",
              },
            ],
          },
        ],
        {
          attachmentCount: 1,
          attachmentFilenames: [],
          baselineUserMessageCount: 0,
          text: "",
        },
      ),
    ).toBe(true);
  });

  it("does not confirm attachment-only sends when the projected attachment id is wrong", () => {
    expect(
      userMessageAcknowledgesComposerSend(
        [
          {
            role: "user",
            parts: [
              {
                type: "image_reference",
                label: "[image #1]",
                attachmentId: "att_other",
              },
            ],
          },
        ],
        {
          attachmentIds: ["att_screenshot"],
          attachmentFilenames: [],
          baselineUserMessageCount: 0,
          text: "",
        },
      ),
    ).toBe(false);
  });

  it("does not confirm attachment-only sends when the projected filename is wrong", () => {
    expect(
      userMessageAcknowledgesComposerSend(
        [
          {
            role: "user",
            parts: [
              {
                type: "image_reference",
                label: "[image #1]",
                filename: "IMG_other.png",
              },
            ],
          },
        ],
        {
          attachmentFilenames: ["IMG_0404.png"],
          baselineUserMessageCount: 0,
          text: "",
        },
      ),
    ).toBe(false);
  });

  it("confirms text plus attachment sends from the echoed text", () => {
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
    expect(
      userMessageAcknowledgesComposerSend(
        [
          {
            role: "user",
            parts: [
              { type: "text", text: "Queue up. Why didn't this echo ack?" },
              { type: "image_reference", label: "[image #1]" },
            ],
          },
        ],
        {
          attachmentIds: ["att_uploaded"],
          attachmentFilenames: ["IMG_0428.png"],
          baselineUserMessageCount: 0,
          text: "Queue up. Why didn't this echo ack?",
        },
      ),
    ).toBe(true);
    expect(
      userMessageAcknowledgesComposerSend(
        [
          {
            role: "user",
            parts: [
              { type: "text", text: "Different queue item" },
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
    ).toBe(false);
  });
});
