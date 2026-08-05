import { describe, expect, it } from "vitest";

import {
  messagesFromParsedAgentOutput,
  transcriptMessageText,
  type ParsedAgentOutputLike,
} from "./agent-transcript.js";

const parsed = (blocks: Array<{ type: string; text: string }>): ParsedAgentOutputLike => ({
  blocks,
});

describe("messagesFromParsedAgentOutput", () => {
  it("keeps the conversation and drops the furniture", () => {
    const messages = messagesFromParsedAgentOutput(
      parsed([
        { type: "status", text: "⚠ `--dangerously-bypass-hook-trust` is enabled." },
        { type: "meta", text: "╭──────────╮\n│ >_ OpenAI Codex │\n╰──────────╯" },
        { type: "prompt", text: "How many published events are there?" },
        { type: "response", text: "Published events: 21" },
      ]),
    );

    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[1]!.text).toBe("Published events: 21");
  });

  it("identifies a message by content, so a sliding window does not renumber it", () => {
    const blocks = [
      { type: "prompt", text: "one" },
      { type: "response", text: "two" },
    ];
    const first = messagesFromParsedAgentOutput(parsed(blocks));
    // The same message after an older one has scrolled out of the window.
    const later = messagesFromParsedAgentOutput(parsed(blocks.slice(1)));

    expect(later[0]!.id).toBe(first[1]!.id);
  });

  it("marks only the newest message, which is the one still being written", () => {
    const messages = messagesFromParsedAgentOutput(
      parsed([
        { type: "prompt", text: "one" },
        { type: "response", text: "two" },
      ]),
    );

    expect(messages[0]!.latest).toBeUndefined();
    expect(messages[1]!.latest).toBe(true);
  });

  it("numbers a repeated message rather than colliding", () => {
    const messages = messagesFromParsedAgentOutput(
      parsed([
        { type: "prompt", text: "yes" },
        { type: "prompt", text: "yes" },
      ]),
    );

    expect(new Set(messages.map((m) => m.id)).size).toBe(2);
  });

  it("reads an attachment block into an image part", () => {
    const [message] = messagesFromParsedAgentOutput(
      parsed([
        {
          type: "prompt",
          text:
            "look at this\n\nAttached image files:\n" +
            "- shot.png (image/png, 1234 bytes): /srv/x/.aimux/attachments/att_abc123.png",
        },
      ]),
    );

    expect(message!.parts).toEqual([
      { type: "text", text: "look at this" },
      {
        type: "image_reference",
        label: "[image #1]",
        attachmentId: "att_abc123",
        filename: "shot.png",
        mimeType: "image/png",
      },
    ]);
  });

  it("still finds the attachment when tmux has reflowed the block", () => {
    const [message] = messagesFromParsedAgentOutput(
      parsed([
        {
          type: "prompt",
          text:
            "look   at this Attached image files: - shot.png (image/png, 12 bytes): " +
            "/srv/x/.aimux/attach\nments/att_wrapped.png",
        },
      ]),
    );

    const images = message!.parts.filter((p) => p.type === "image_reference");
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ attachmentId: "att_wrapped" });
  });

  it("gives one attachment one label, however often it appears", () => {
    const line = (id: string) => `Attached image files:\n- a.png (image/png, 1 bytes): /x/.aimux/attachments/${id}.png`;
    const messages = messagesFromParsedAgentOutput(
      parsed([
        { type: "prompt", text: `first\n\n${line("att_one")}` },
        { type: "prompt", text: `again\n\n${line("att_one")}` },
        { type: "prompt", text: `other\n\n${line("att_two")}` },
      ]),
    );

    const labels = messages.flatMap((m) => m.parts.filter((p) => p.type === "image_reference").map((p) => p.label));
    expect(labels).toEqual(["[image #1]", "[image #1]", "[image #2]"]);
  });

  it("emits no url, because the server does not know the caller's path to it", () => {
    const messages = messagesFromParsedAgentOutput(
      parsed([
        {
          type: "prompt",
          text: "Attached image files:\n- a.png (image/png, 1 bytes): /x/.aimux/attachments/att_z.png",
        },
      ]),
    );

    expect(JSON.stringify(messages)).not.toContain("contentUrl");
    expect(JSON.stringify(messages)).not.toContain("/attachments/att_z/content");
  });

  it("survives nothing at all", () => {
    expect(messagesFromParsedAgentOutput(null)).toEqual([]);
    expect(messagesFromParsedAgentOutput({})).toEqual([]);
    expect(messagesFromParsedAgentOutput(parsed([{ type: "prompt", text: "   " }]))).toEqual([]);
  });
});

describe("transcriptMessageText", () => {
  it("joins the words and leaves the images out", () => {
    expect(
      transcriptMessageText([
        { type: "text", text: "before" },
        { type: "image_reference", label: "[image #1]", attachmentId: "att_a" },
        { type: "text", text: "after" },
      ]),
    ).toBe("before\nafter");
  });
});

describe("a block mangled by a wrap", () => {
  it("keeps the words as well as the recovered image", () => {
    const [message] = messagesFromParsedAgentOutput(
      parsed([
        {
          type: "prompt",
          text:
            "please look at the seat map Attached image files: - shot.png (image/png, 9 bytes): " +
            "/srv/x/.aimux/attach\nments/att_mangled.png",
        },
      ]),
    );

    const text = message!.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join(" ");
    expect(text).toContain("please look at the seat map");
    expect(message!.parts.filter((p) => p.type === "image_reference")).toHaveLength(1);
  });

  it("does not invent an image for a block that only mentions the header", () => {
    const [message] = messagesFromParsedAgentOutput(
      parsed([{ type: "response", text: "I looked for Attached image files: and found none." }]),
    );

    expect(message!.parts.filter((p) => p.type === "image_reference")).toHaveLength(0);
    expect(message!.text).toContain("found none");
  });
});
