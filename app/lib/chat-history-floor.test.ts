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

describe("whether a declined page was declined by the floor", () => {
  const atTop = { contentHeight: 4000, offsetY: 0, viewportHeight: 800 };

  it("is the floor only when the reader was asking for more", () => {
    expect(
      chatHistoryAtFloor({ currentStartLine: CHAT_OUTPUT_MAX_CAPTURE_START_LINE, metrics: atTop }),
    ).toBe(true);
  });

  // The resume path drives the cursor to the floor with no scrolling, so the
  // cursor alone would caption a chat nobody paged.
  it("is not the floor when the reader is nowhere near the top", () => {
    expect(
      chatHistoryAtFloor({
        currentStartLine: CHAT_OUTPUT_MAX_CAPTURE_START_LINE,
        metrics: { ...atTop, offsetY: 2400 },
      }),
    ).toBe(false);
  });

  // Declined for another reason -- a page already in flight, or the view
  // disabled -- while there is still history to fetch.
  it("is not the floor while there are pages left", () => {
    expect(chatHistoryAtFloor({ currentStartLine: -480, metrics: atTop })).toBe(false);
  });
});
