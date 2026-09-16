import { describe, expect, it } from "vitest";

import {
  COMPOSER_ECHO_CONFIRMATION_TIMEOUT_MS,
  mergeAcceptedComposerEchoes,
  type AcceptedComposerEcho,
} from "./composer-echo";
import type { ChatMessage } from "./events";

function userMessage(id: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
    text,
    ...extra,
  };
}

function echo(
  id: string,
  text: string,
  extra: Partial<AcceptedComposerEcho> = {},
): AcceptedComposerEcho {
  return {
    baselineMessageCount: 0,
    baselineUserMessageCount: 0,
    clientMessageId: id,
    createdAtMs: 1_000,
    message: userMessage(id, text, { clientMessageId: id }),
    ...extra,
  };
}

describe("composer optimistic echo reconciliation", () => {
  it("replaces an optimistic echo with its server confirmation exactly once", () => {
    const pending = echo("composer:one", "queue up", {
      message: userMessage("composer:one", "queue up", {
        clientMessageId: "composer:one",
        parts: [
          { type: "text", text: "queue up" },
          {
            type: "image_reference",
            label: "[image #1]",
            attachmentId: "att_local",
            contentUrl: "/attachments/att_local/content",
          },
        ],
      }),
    });
    const confirmed = userMessage("user:confirmed", "queue up", {
      parts: [
        { type: "text", text: "queue up" },
        {
          type: "image_reference",
          label: "[image #1]",
          attachmentId: "att_uploaded",
          contentUrl: "/attachments/att_uploaded/content",
          hostedContentUrl: "https://relay.example.test/attachments/hosted/ha_1/content",
        },
      ],
    });

    expect(
      mergeAcceptedComposerEchoes([], [pending], { nowMs: 1_500 }).messages.map(
        (message) => message.id,
      ),
    ).toEqual(["composer:one"]);

    const reconciled = mergeAcceptedComposerEchoes([confirmed], [pending], { nowMs: 1_500 });

    expect(reconciled.messages).toHaveLength(1);
    expect(reconciled.messages[0]).toMatchObject({
      id: "user:confirmed",
      clientMessageId: "composer:one",
      parts: confirmed.parts,
    });
    expect(reconciled.echoes).toEqual([{ ...pending, settled: true }]);
  });

  it("keeps two deliberately identical messages by claiming distinct confirmations", () => {
    const first = echo("composer:first", "same text");
    const second = echo("composer:second", "same text");
    const confirmed = [
      userMessage("user:first", "same text"),
      userMessage("user:second", "same text"),
    ];

    const reconciled = mergeAcceptedComposerEchoes(confirmed, [first, second], { nowMs: 1_500 });

    expect(reconciled.messages).toHaveLength(2);
    expect(reconciled.messages.map((message) => message.id)).toEqual(["user:first", "user:second"]);
    expect(reconciled.messages.map((message) => message.clientMessageId)).toEqual([
      "composer:first",
      "composer:second",
    ]);
  });

  it("drops an echo that never confirms instead of leaving a delivered-looking phantom", () => {
    const pending = echo("composer:missing", "lost");

    const reconciled = mergeAcceptedComposerEchoes([], [pending], {
      nowMs: 1_000 + COMPOSER_ECHO_CONFIRMATION_TIMEOUT_MS,
    });

    expect(reconciled.messages).toEqual([]);
    expect(reconciled.echoes).toEqual([]);
    expect(reconciled.droppedUnconfirmedCount).toBe(1);
  });

  it("shows the server transcript and drops an echo when the transcript advances without a user confirmation", () => {
    const pending = echo("composer:missing", "lost");
    const assistant: ChatMessage = {
      id: "assistant:next",
      role: "assistant",
      parts: [{ type: "text", text: "next" }],
      text: "next",
    };

    const reconciled = mergeAcceptedComposerEchoes([assistant], [pending], { nowMs: 1_500 });

    expect(reconciled.messages).toEqual([assistant]);
    expect(reconciled.echoes).toEqual([]);
    expect(reconciled.droppedUnconfirmedCount).toBe(1);
  });
});
