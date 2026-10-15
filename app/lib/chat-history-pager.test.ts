import { describe, expect, it } from "vitest";

import {
  CHAT_HISTORY_PAGE_FAILURE_LIMIT,
  CHAT_OUTPUT_CAPTURE_START_LINE,
  CHAT_OUTPUT_MAX_CAPTURE_START_LINE,
  nextChatOutputCaptureStartLine,
} from "@/lib/chat-output-constants";
import {
  type ChatHistoryPagerState,
  chatHistoryPagerResolved,
  chatHistoryPagerScrolled,
  chatHistoryPagerState,
} from "@/lib/chat-history-pager";

const AT_TOP = { contentHeight: 4_000, offsetY: 0, viewportHeight: 800 };
const SCROLLED_AWAY = { contentHeight: 4_000, offsetY: 900, viewportHeight: 800 };

/** One scroll to the top, and whatever the service did with it. */
function scrollToTop(
  state: ChatHistoryPagerState,
  serve: (requested: number) => { arrived: boolean; appliedStartLine?: number },
): { state: ChatHistoryPagerState; requested: number | null } {
  const scrolled = chatHistoryPagerScrolled(state, {
    metrics: AT_TOP,
    ready: true,
    pendingStartLine: null,
  });
  if (scrolled.request === null) return { state: scrolled.state, requested: null };
  const served = serve(scrolled.request);
  return {
    state: chatHistoryPagerResolved(scrolled.state, {
      requestedStartLine: scrolled.request,
      ...served,
    }),
    requested: scrolled.request,
  };
}

const NEVER_SERVED = () => ({ arrived: false });
const SERVES_WHAT_WAS_ASKED = (requested: number) => ({
  arrived: true,
  appliedStartLine: requested,
});

describe("scrolling up with no backend", () => {
  it("never moves the cursor, however many times the reader tries", () => {
    // The original bug: `refreshOutputSnapshot` answers without asking when
    // there is no endpoint, and the cursor advanced anyway -- walking from the
    // live window to the floor with zero network calls, after which every page
    // asked for a window nothing would serve.
    let state = chatHistoryPagerState();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      state = scrollToTop(state, NEVER_SERVED).state;
      expect(state.startLine).toBe(CHAT_OUTPUT_CAPTURE_START_LINE);
    }
    expect(state.pagedAtLeastOnce).toBe(false);
    expect(state.floorReached, "and it must not claim a floor either").toBe(false);
  });

  it("stops asking after a few tries, and asks again when the reader comes back", () => {
    let state = chatHistoryPagerState();
    const asked: (number | null)[] = [];
    for (let attempt = 0; attempt < CHAT_HISTORY_PAGE_FAILURE_LIMIT + 3; attempt += 1) {
      const step = scrollToTop(state, NEVER_SERVED);
      state = step.state;
      asked.push(step.requested);
    }
    expect(asked.filter((request) => request !== null)).toHaveLength(
      CHAT_HISTORY_PAGE_FAILURE_LIMIT,
    );

    // Scrolling away and back is what trying again looks like.
    state = chatHistoryPagerScrolled(state, {
      metrics: SCROLLED_AWAY,
      ready: true,
      pendingStartLine: null,
    }).state;
    expect(scrollToTop(state, NEVER_SERVED).requested).not.toBeNull();
  });
});

describe("scrolling up against a service that answers", () => {
  it("walks back one page at a time", () => {
    let state = chatHistoryPagerState();
    const first = scrollToTop(state, SERVES_WHAT_WAS_ASKED);
    state = first.state;
    expect(first.requested).toBe(nextChatOutputCaptureStartLine(CHAT_OUTPUT_CAPTURE_START_LINE));
    expect(state.startLine).toBe(first.requested);
    expect(state.pagedAtLeastOnce).toBe(true);

    const second = scrollToTop(state, SERVES_WHAT_WAS_ASKED);
    expect(second.requested).toBe(nextChatOutputCaptureStartLine(state.startLine));
    expect(second.state.startLine).toBe(second.requested);
  });

  it("recovers the brake as soon as one page is served", () => {
    let state = chatHistoryPagerState();
    state = scrollToTop(state, NEVER_SERVED).state;
    expect(state.failures).toBe(1);
    state = scrollToTop(state, SERVES_WHAT_WAS_ASKED).state;
    expect(state.failures, "a served page clears the count").toBe(0);
  });

  it("counts a page with no served line of its own", () => {
    // The field is optional in the contract, and the store writes undefined
    // for it while keeping the messages -- so reading that as nothing stopped
    // paging on history already on screen.
    let state = chatHistoryPagerState();
    const step = scrollToTop(state, () => ({ arrived: true }));
    state = step.state;
    expect(state.startLine).toBe(step.requested);
    expect(state.failures).toBe(0);
  });
});

describe("a service with less history than was asked for", () => {
  it("takes the shallower window as the floor and stops asking", () => {
    // The constant floor is only this view's own bound. The service has one of
    // its own and cannot be asked for it, so asking and learning there is no
    // more is the only honest signal -- and it has to latch, because a served
    // page clears the failure count and the brake cannot catch a loop.
    let state = chatHistoryPagerState();
    const step = scrollToTop(state, () => ({ arrived: true, appliedStartLine: -320 }));
    state = step.state;
    expect(state.startLine).toBe(-320);

    const clamped = scrollToTop(state, () => ({ arrived: true, appliedStartLine: -320 }));
    expect(clamped.state.floorReached).toBe(true);
    expect(
      scrollToTop(clamped.state, SERVES_WHAT_WAS_ASKED).requested,
      "and it must not ask again once the service has answered",
    ).toBeNull();
  });
});

describe("re-entering a chat whose history was already read", () => {
  it("picks up where it left off", () => {
    expect(chatHistoryPagerState(-640).startLine).toBe(-640);
  });

  it("can still ask, even when the stored window was the floor", () => {
    // Seeding to the floor made scroll-up a dead end: the request is declined
    // and the floor notice needs a page THIS mount was given, so it did
    // nothing and said nothing.
    const state = chatHistoryPagerState(CHAT_OUTPUT_MAX_CAPTURE_START_LINE);
    expect(scrollToTop(state, SERVES_WHAT_WAS_ASKED).requested).not.toBeNull();
  });
});
