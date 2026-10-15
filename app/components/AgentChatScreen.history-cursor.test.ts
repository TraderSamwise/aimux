import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The screen must DELEGATE the paging decision, not make one of its own.
 *
 * This file used to assert the decision itself, by counting patterns in the
 * source -- and four mutations survived that, including restoring the original
 * bug verbatim, because grepping for a call proves the call is written and
 * nothing about what it decides. The rules now live in `chat-history-pager`
 * and are driven there against real sequences; all this has to hold is that
 * the screen has not grown a second opinion.
 */
const screenSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "screens", "AgentChatScreen.tsx"),
  "utf8",
);

describe("the chat history pager is not re-decided in the screen", () => {
  it("keeps the whole pager state in one ref", () => {
    // Four separate refs drifted apart once: the cursor was asked from state
    // and decided against a ref, which stuck the floor notice on a chat with
    // plenty of history left.
    expect(screenSource).toContain("chatHistoryPagerRef");
    for (const gone of [
      "chatOutputHistoryStartLineRef",
      "chatHistoryFailuresRef",
      "chatHistoryPagedRef",
      "setChatOutputHistoryStartLine",
    ]) {
      expect(screenSource, `${gone} is the pager's business now`).not.toContain(gone);
    }
  });

  it("asks the pager rather than the constants", () => {
    // Each of these is a rule with a sequence behind it, and a screen that
    // calls them directly is a second place those sequences can go wrong.
    for (const rule of [
      "chatHistoryPageOutcome(",
      "chatHistoryPagingAllowed(",
      "chatHistoryPagingRetryable(",
      "chatHistorySeedStartLine(",
      "chatOutputHistoryStartLineForScroll(",
    ]) {
      expect(screenSource, `${rule} belongs to the pager`).not.toContain(rule);
    }
    expect(screenSource).toContain("chatHistoryPagerScrolled(");
    expect(screenSource).toContain("chatHistoryPagerResolved(");
  });

  it("hands the pager what it was served, not what it asked for", () => {
    // The served line is what the pager compares against, and it can only come
    // from the feed as the snapshot is applied: the store's copy survives only
    // until the next stream event carrying none.
    expect(screenSource.split("onSnapshotApplied:").length - 1).toBe(2);
    expect(screenSource.split("appliedStartLine: served").length - 1).toBe(2);
  });
});
