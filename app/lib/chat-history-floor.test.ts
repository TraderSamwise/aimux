import { describe, expect, it } from "vitest";
import {
  CHAT_HISTORY_FLOOR_LINES,
  chatHistoryAtFloor,
  chatHistoryFloorNotice,
} from "./chat-history-floor";
import { CHAT_OUTPUT_MAX_CAPTURE_START_LINE } from "./chat-output-constants";

describe("why scrolling up stopped", () => {
  it("says nothing while there are more pages to fetch", () => {
    expect(chatHistoryFloorNotice(false)).toBeNull();
  });

  it("states what the view loads once it has stopped", () => {
    expect(chatHistoryFloorNotice(true)).toBe("This view loads at most the last 2000 lines");
  });

  // The number is the pager's own floor, not the service's `captureLineLimit`:
  // the app asks for 160 lines and the service reports 2000 whatever it asked
  // for, so reading the response would have put the wrong number on screen.
  it("counts from the pager's floor", () => {
    expect(CHAT_HISTORY_FLOOR_LINES).toBe(-CHAT_OUTPUT_MAX_CAPTURE_START_LINE);
  });
});

describe("whether a declined page means there is no further to go", () => {
  const scrolledToTop = { contentHeight: 4000, offsetY: 0, viewportHeight: 800 };
  const floor = CHAT_OUTPUT_MAX_CAPTURE_START_LINE;

  it("is the floor when the reader paged there and asked for more", () => {
    expect(
      chatHistoryAtFloor({
        currentStartLine: floor,
        metrics: scrolledToTop,
        pagedAtLeastOnce: true,
      }),
    ).toBe(true);
  });

  // The resume read advances the cursor before its own request resolves, and
  // a refresh with no endpoint returns without fetching, so the cursor alone
  // would caption a chat nobody paged.
  it("is not the floor when no page ever arrived", () => {
    expect(
      chatHistoryAtFloor({
        currentStartLine: floor,
        metrics: scrolledToTop,
        pagedAtLeastOnce: false,
      }),
    ).toBe(false);
  });

  // A transcript shorter than the viewport sits at offset 0 forever, so being
  // "near the top" says nothing about what the reader wanted.
  it("is not the floor when there is nothing to scroll", () => {
    expect(
      chatHistoryAtFloor({
        currentStartLine: floor,
        metrics: { contentHeight: 400, offsetY: 0, viewportHeight: 800 },
        pagedAtLeastOnce: true,
      }),
    ).toBe(false);
  });

  it("is not the floor when the reader is nowhere near the top", () => {
    expect(
      chatHistoryAtFloor({
        currentStartLine: floor,
        metrics: { ...scrolledToTop, offsetY: 2400 },
        pagedAtLeastOnce: true,
      }),
    ).toBe(false);
  });

  it("is not the floor while there are pages left", () => {
    expect(
      chatHistoryAtFloor({
        currentStartLine: -480,
        metrics: scrolledToTop,
        pagedAtLeastOnce: true,
      }),
    ).toBe(false);
  });
});
