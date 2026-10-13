import { describe, expect, it } from "vitest";

import {
  COMPOSER_SEND_AWAITING_ECHO_NOTICE,
  COMPOSER_SEND_TIMEOUT_MESSAGE,
  composerSendNotice,
  heldDeliveryStillPending,
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

  it("sends on a hardware Enter and breaks the line on Shift+Enter", () => {
    expect(shouldSubmitComposerKey({ key: "Enter" }, true)).toBe(true);
    expect(shouldSubmitComposerKey({ key: "Enter", shiftKey: true }, true)).toBe(false);
    expect(shouldSubmitComposerKey({ key: "Enter", ctrlKey: true }, true)).toBe(false);
    expect(shouldSubmitComposerKey({ key: "Enter", metaKey: true }, true)).toBe(false);
    expect(shouldSubmitComposerKey({ key: "Enter", altKey: true }, true)).toBe(false);
    expect(shouldSubmitComposerKey({ key: "a" }, true)).toBe(false);
  });

  it("refuses a key that does not physically exist", () => {
    // A floating or split on-screen keyboard overlays the page instead of
    // taking a bite out of the viewport, so no measurement can see it. The
    // event can: `code` names the physical key, and there is not one.
    expect(shouldSubmitComposerKey({ key: "Enter", code: "" }, true)).toBe(false);
    expect(shouldSubmitComposerKey({ key: "Enter", code: "Enter" }, true)).toBe(true);
    expect(shouldSubmitComposerKey({ key: "Enter", code: "NumpadEnter" }, true)).toBe(true);
    // A browser that does not report it has said nothing, which is not
    // evidence that no key was pressed.
    expect(shouldSubmitComposerKey({ key: "Enter" }, true)).toBe(true);
  });

  it("never sends on Enter without a hardware keyboard", () => {
    // A soft keyboard's return key is the newline key, and the send control is
    // the only send. Sending here swallowed the line break mid-sentence.
    expect(shouldSubmitComposerKey({ key: "Enter" }, false)).toBe(false);
    expect(shouldSubmitComposerKey({ key: "Enter", shiftKey: true }, false)).toBe(false);
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

describe("what the composer says about a send that worked", () => {
  const base = {
    transcriptVisible: false,
    sending: false,
    awaitingEcho: false,
    heldNotice: null,
    error: null,
  };

  // The bug: terminal mode does not mount the transcript pane, so the one
  // thing that confirmed a send -- the message appearing in it -- was not on
  // screen, and a send that worked looked like one that did nothing.
  it("confirms the send where there is no transcript to show it in", () => {
    expect(composerSendNotice({ ...base, awaitingEcho: true })).toEqual({
      kind: "awaiting",
      text: COMPOSER_SEND_AWAITING_ECHO_NOTICE,
    });
  });

  // Once the echo lands, the pane the user is looking at shows the message,
  // so a lingering notice would claim a fact that is already on screen.
  it("stops once the echo has landed", () => {
    expect(composerSendNotice(base)).toBeNull();
  });

  // Where there IS a transcript, the row is the confirmation and a second one
  // beside it is noise.
  it("says nothing where the transcript already shows it", () => {
    expect(composerSendNotice({ ...base, transcriptVisible: true, awaitingEcho: true })).toBeNull();
  });

  // A queued send is the one notice that shows in every mode: it is not a
  // duplicate of the transcript row, it is the only thing telling the user
  // their input is waiting behind typed text in the agent's own terminal.
  it("shows a held send everywhere, transcript or not", () => {
    for (const transcriptVisible of [true, false]) {
      expect(
        composerSendNotice({ ...base, transcriptVisible, heldNotice: "Input held: because" }),
      ).toEqual({ kind: "held", text: "Input held: because" });
    }
  });

  it("yields to the louder facts", () => {
    // An error renders on its own and is the thing that matters.
    expect(composerSendNotice({ ...base, awaitingEcho: true, error: "nope" })).toBeNull();
    // The send button carries the in-flight state.
    expect(composerSendNotice({ ...base, sending: true, awaitingEcho: true })).toBeNull();
  });
});

describe("whether a held send is still waiting", () => {
  // The service delivers it within the 15s hold and the input comes back as a
  // user message, so the transcript moving past where it was queued is the
  // signal. Without this the notice claimed "not delivered yet" about
  // something already delivered.
  it("waits while the transcript has not moved", () => {
    expect(heldDeliveryStillPending({ heldAtUserMessageCount: 3, userMessageCount: 3 })).toBe(true);
  });

  it("retires once the queued input lands", () => {
    expect(heldDeliveryStillPending({ heldAtUserMessageCount: 3, userMessageCount: 4 })).toBe(
      false,
    );
  });

  // A transcript that shrank -- a shallower window, a different session --
  // is not evidence the input landed.
  it("keeps waiting if the transcript went backwards", () => {
    expect(heldDeliveryStillPending({ heldAtUserMessageCount: 3, userMessageCount: 1 })).toBe(true);
  });
});
