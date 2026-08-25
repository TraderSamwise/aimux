import { describe, expect, it } from "vitest";

import { createAgentOutputSseTextHandler } from "./agent-output-stream.js";

describe("agent output stream text handler", () => {
  it("writes incremental output without duplicating prior frames", () => {
    const chunks: string[] = [];
    const handler = createAgentOutputSseTextHandler("codex-1", (text) => chunks.push(text));

    handler.pushChunkText('event: output\ndata: {"output":"one"}\n\n');
    handler.pushChunkText('event: output\ndata: {"output":"one\\ntwo"}\n\n');

    expect(chunks.join("")).toBe("one\n\ntwo\n");
  });

  it("marks tail output once", () => {
    const chunks: string[] = [];
    const handler = createAgentOutputSseTextHandler("codex-1", (text) => chunks.push(text));

    handler.pushChunkText('event: output\ndata: {"output":"tail","captureLineLimit":2000,"outputTailOnly":true}\n\n');
    handler.pushChunkText(
      'event: output\ndata: {"output":"tail\\nnew","captureLineLimit":2000,"outputTailOnly":true}\n\n',
    );

    expect(chunks.join("")).toBe("[aimux showing last 2000 lines]\ntail\n\nnew\n");
  });

  it("diffs sliding tail windows by overlap instead of replaying the whole tail", () => {
    const chunks: string[] = [];
    const handler = createAgentOutputSseTextHandler("codex-1", (text) => chunks.push(text));

    handler.pushChunkText('event: output\ndata: {"output":"a\\nb\\nc","captureLineLimit":3,"outputTailOnly":true}\n\n');
    handler.pushChunkText('event: output\ndata: {"output":"b\\nc\\nd","captureLineLimit":3,"outputTailOnly":true}\n\n');

    expect(chunks.join("")).toBe("[aimux showing last 3 lines]\na\nb\nc\n\nd\n");
  });
});
