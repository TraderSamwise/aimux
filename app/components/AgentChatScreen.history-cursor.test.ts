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
    // The second trigger, pinned the same way. A transcript that does not
    // overflow emits no scroll event, so this is the only path that can ask.
    expect(screenSource).toContain("chatHistoryPagerContentSized(");
  });

  it("asks from the content-size path, not only from a scroll", () => {
    // Naming the rule is not the same as reaching it: the rule stays
    // referenced inside `requestChatHistoryPage` even if nothing ever calls
    // that with "content", which is how a short transcript lost its only way
    // to page in the first place.
    const handler = screenSource.slice(screenSource.indexOf("const handleChatContentSizeChange"));
    const body = handler.slice(0, handler.indexOf("[executeChatScrollCommand"));
    expect(body, "the content-size handler must ask the pager").toContain(
      'onRequestHistoryPage(chatScrollMetricsRef.current, "content")',
    );

    // And layout, which is the half that supplies the viewport height. It has
    // to ask BEFORE the initial-layout branch, because that branch returns --
    // on a cold mount, the one case this path exists for, anything after it
    // never runs.
    const layout = screenSource.slice(screenSource.indexOf("const handleChatLayout"));
    const layoutBody = layout.slice(0, layout.indexOf("[executeChatScrollCommand"));
    const askAt = layoutBody.indexOf(
      'onRequestHistoryPage(chatScrollMetricsRef.current, "content")',
    );
    const returnAt = layoutBody.indexOf("chatInitialLayoutKeyRef.current = agentKey");
    expect(askAt, "the layout handler must ask the pager").toBeGreaterThanOrEqual(0);
    expect(askAt, "asking after the initial-layout return never runs").toBeLessThan(returnAt);
  });

  it("hands the pager what it was served, not what it asked for", () => {
    // The served line is what the pager compares against, and it can only come
    // from the feed as the snapshot is applied: the store's copy survives only
    // until the next stream event carrying none.
    expect(screenSource.split("onSnapshotApplied:").length - 1).toBe(2);
    expect(screenSource.split("appliedStartLine: served").length - 1).toBe(2);
  });
});
