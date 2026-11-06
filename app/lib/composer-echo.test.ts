import { describe, expect, it } from "vitest";

import {
  COMPOSER_ECHO_CONFIRMATION_TIMEOUT_MS,
  mergeAcceptedComposerEchoes,
  sameAcceptedComposerEchoes,
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
        pendingComposerEcho: true,
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
      mergeAcceptedComposerEchoes([], [pending], { nowMs: 1_500 }).messages.map((message) => [
        message.id,
        message.pendingComposerEcho,
      ]),
    ).toEqual([["composer:one", true]]);

    const reconciled = mergeAcceptedComposerEchoes([confirmed], [pending], { nowMs: 1_500 });

    expect(reconciled.messages).toHaveLength(1);
    expect(reconciled.messages[0]).toMatchObject({
      id: "user:confirmed",
      clientMessageId: "composer:one",
      parts: confirmed.parts,
    });
    expect(reconciled.messages[0]).not.toHaveProperty("pendingComposerEcho");
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
    expect(reconciled.droppedExpiredCount).toBe(1);
    expect(reconciled.droppedTranscriptAdvancedCount).toBe(0);
  });

  it("lets a command's echo expire without calling it an unconfirmed send", () => {
    // Confirmation is echo-based: a send is confirmed by its text turning up
    // in the parsed transcript. A command is consumed by the agent and need
    // not come back as a user turn, so its echo expiring is the expected
    // ending -- `droppedExpiredCount` is what raises "Send not confirmed
    // yet", and raising it here blamed the connection for a command that ran.
    const command = echo("composer:slash", "/queue", { expectsTranscriptEcho: false });

    const reconciled = mergeAcceptedComposerEchoes([], [command], {
      nowMs: 1_000 + COMPOSER_ECHO_CONFIRMATION_TIMEOUT_MS,
    });

    // Still dropped, so no phantom bubble is left behind. Only the meaning of
    // the drop differs.
    expect(reconciled.messages).toEqual([]);
    expect(reconciled.echoes).toEqual([]);
    expect(reconciled.droppedUnconfirmedCount).toBe(1);
    expect(reconciled.droppedExpiredCount).toBe(0);
  });

  it("still shows a command's echo while it waits", () => {
    // The flag is about what the expiry MEANS, not about skipping the echo.
    // Skipping it outright left a command with no optimistic bubble and, in
    // terminal mode, no confirmation at all.
    const command = echo("composer:slash", "/queue", { expectsTranscriptEcho: false });

    const reconciled = mergeAcceptedComposerEchoes([], [command], { nowMs: 1_500 });

    expect(reconciled.messages.map((message) => message.id)).toEqual(["composer:slash"]);
    expect(reconciled.echoes).toEqual([command]);
  });

  it("treats an echo that says nothing as one that expects its echo", () => {
    // An echo built without the flag keeps the old meaning, which is the safe
    // direction: a missing field must not silence a real failed send.
    const pending = echo("composer:missing", "lost");
    expect(pending.expectsTranscriptEcho).toBeUndefined();

    expect(
      mergeAcceptedComposerEchoes([], [pending], {
        nowMs: 1_000 + COMPOSER_ECHO_CONFIRMATION_TIMEOUT_MS,
      }).droppedExpiredCount,
    ).toBe(1);
  });

  it("shows the server transcript without treating an agent answer as retryable", () => {
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
    expect(reconciled.droppedExpiredCount).toBe(0);
    expect(reconciled.droppedTranscriptAdvancedCount).toBe(1);
  });
});

describe("settling reaches a fixed point", () => {
  // The effect that settles echoes depends on the echo state AND writes it
  // back, so it only terminates if "nothing changed" can be recognised.
  // `mergeAcceptedComposerEchoes` always allocates a fresh `echoes` array, so
  // a reference check is always unequal -- set state, re-render, merge, set
  // state, for ever. That infinite render loop hung the app suite for over an
  // hour before it was caught.
  it("recognises an unchanged echo list by value, not reference", () => {
    const pending = echo("composer:one", "still waiting");
    const first = mergeAcceptedComposerEchoes([], [pending], { nowMs: 1_000 });

    expect(sameAcceptedComposerEchoes(first.echoes, [pending])).toBe(true);
  });

  it("settles after no writes rather than looping", () => {
    const pending = echo("composer:one", "still waiting");
    let echoes: AcceptedComposerEcho[] = [pending];
    let writes = 0;

    // Exactly what the effect does, run until it stops changing.
    for (let pass = 0; pass < 10; pass += 1) {
      const result = mergeAcceptedComposerEchoes([], echoes, { nowMs: 1_000 });
      if (sameAcceptedComposerEchoes(result.echoes, echoes)) break;
      echoes = result.echoes;
      writes += 1;
    }

    expect(writes).toBe(0);
  });

  it("tells a real change from an unchanged list", () => {
    const pending = echo("composer:one", "still waiting");
    expect(sameAcceptedComposerEchoes([pending], [])).toBe(false);
    expect(sameAcceptedComposerEchoes([pending], [{ ...pending }])).toBe(false);
    expect(sameAcceptedComposerEchoes([pending], [pending])).toBe(true);
  });
});
