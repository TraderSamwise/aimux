import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Both paths that move the history cursor must go through one decision.
 *
 * They drifted apart once already: the scroll pager advanced the cursor in a
 * `.then` that ignored its result, and the resume read advanced it before its
 * own request resolved. A cursor that moves for a fetch that never happened
 * walks to the floor with zero network calls, and every page after that asks
 * for a window nothing will serve. Pure helpers cannot catch that -- the bug
 * is in which of them each call site uses.
 */
const screenSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "screens", "AgentChatScreen.tsx"),
  "utf8",
);

function occurrences(pattern: string): number {
  return screenSource.split(pattern).length - 1;
}

describe("the chat history cursor has one decision", () => {
  it("is only ever written by the agent reset and the shared applier", () => {
    // Two writers, and the test says which: the per-agent reset seeds it and
    // the applier moves it. Anything else is a third path that can move it
    // without a page.
    expect(occurrences("chatOutputHistoryStartLineRef.current =")).toBe(2);
    // And it is a ref, not state: nothing renders from it, so state meant
    // three writers and no readers.
    expect(screenSource).not.toContain("setChatOutputHistoryStartLine");
  });

  it("decides what a page meant in exactly one place", () => {
    expect(occurrences("chatHistoryPageOutcome({")).toBe(1);
    // And both paging paths call that one place.
    // Two call sites, and the declaration does not match this pattern.
    expect(occurrences("applyChatHistoryPageOutcome(")).toBe(2);
    // And each one takes the line the feed served, not one read back from the
    // store, which a live stream event can have cleared by then.
    expect(occurrences("onSnapshotApplied: (startLine) => {")).toBe(2);
  });

  it("never advances a cursor straight from a requested start line", () => {
    // The shape of the original bug: `Math.min(current, nextStartLine)` in a
    // `.then`, which moved the cursor to what was ASKED for rather than what
    // was served.
    expect(screenSource).not.toContain("Math.min(current, nextStartLine)");
    expect(screenSource).not.toContain("Math.min(current, CHAT_OUTPUT_MAX_CAPTURE_START_LINE)");
  });

  it("asks and decides against the same value", () => {
    // The pending guard clears in the same microtask chain as the fetch, before
    // React commits the new cursor. Computing the next page from the STATE
    // while deciding the outcome against the REF meant a queued scroll
    // re-requested the same window, was served it, and that read as "no deeper
    // history" -- a sticky floor notice on a chat with plenty left.
    expect(occurrences("currentStartLine: chatOutputHistoryStartLineRef.current")).toBe(3);
    expect(screenSource).not.toContain("currentStartLine: chatOutputHistoryStartLine,");
  });

  it("treats a page with no start line as a page", () => {
    // The field is optional in the contract and the store writes undefined for
    // it, so "arrived" has to be its own fact rather than inferred from the
    // value.
    expect(occurrences("arrived = true;")).toBe(2);
    expect(occurrences("arrived ? (served ??")).toBe(2);
  });

  it("keeps a brake on the pager", () => {
    // Holding the cursor still removes the brake the old bug accidentally
    // provided, so the limit has to be asked for explicitly.
    expect(occurrences("chatHistoryPagingAllowed(")).toBe(1);
    expect(occurrences("chatHistoryFailuresRef.current += 1")).toBe(2);
  });
});
