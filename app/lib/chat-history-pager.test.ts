import { describe, expect, it } from "vitest";

import {
  CHAT_HISTORY_PAGE_FAILURE_LIMIT,
  CHAT_OUTPUT_CAPTURE_START_LINE,
  CHAT_OUTPUT_MAX_CAPTURE_START_LINE,
  nextChatOutputCaptureStartLine,
} from "@/lib/chat-output-constants";
import {
  type ChatHistoryPagerState,
  chatHistoryPagerContentSized,
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

describe("a transcript too short to scroll", () => {
  const short = { contentHeight: 300, offsetY: 0, viewportHeight: 800 };
  const tall = { contentHeight: 2400, offsetY: 0, viewportHeight: 800 };
  const ask = { ready: true, pendingStartLine: null };

  it("asks once, because nothing else can ask at all", () => {
    // The scroll handler is the only other pager, and a node whose content
    // does not overflow emits no scroll event -- so without this the reader
    // has no gesture that reaches history.
    const first = chatHistoryPagerContentSized(chatHistoryPagerState(), { ...ask, metrics: short });
    expect(first.request).toBe(nextChatOutputCaptureStartLine(CHAT_OUTPUT_CAPTURE_START_LINE));
    expect(first.state.filledFromContent).toBe(true);

    // Every content-size change would otherwise ask again. The service echoes
    // back whatever window it was given, so each page reports as progress
    // whether or not any output lies behind it -- a two-message chat would
    // walk to the deepest window and then claim the service ceiling.
    const second = chatHistoryPagerContentSized(first.state, { ...ask, metrics: short });
    expect(second.request).toBeNull();
    expect(second.state).toBe(first.state);
  });

  it("waits until both heights are measured, and does not latch on a zero", () => {
    // `onLayout` and `onContentSizeChange` fill one each and can land in
    // either order. A view measured on one axis only would read as
    // overflowing (and never ask) or as short (and spend its one page on
    // nothing). Asking again after the second measurement is the point.
    const unlaidOut = chatHistoryPagerContentSized(chatHistoryPagerState(), {
      ...ask,
      metrics: { contentHeight: 300, offsetY: 0, viewportHeight: 0 },
    });
    expect(unlaidOut.request).toBeNull();
    expect(unlaidOut.state.filledFromContent).toBe(false);

    const empty = chatHistoryPagerContentSized(chatHistoryPagerState(), {
      ...ask,
      metrics: { contentHeight: 0, offsetY: 0, viewportHeight: 800 },
    });
    expect(empty.request).toBeNull();
    expect(empty.state.filledFromContent).toBe(false);

    expect(
      chatHistoryPagerContentSized(unlaidOut.state, { ...ask, metrics: short }).request,
    ).not.toBeNull();
  });

  it("does not ask when there is something to scroll", () => {
    const overflowing = chatHistoryPagerContentSized(chatHistoryPagerState(), {
      ...ask,
      metrics: tall,
    });
    expect(overflowing.request).toBeNull();
    expect(overflowing.state.filledFromContent).toBe(false);
  });

  it("holds its tongue while a page is in flight, and when the view is not ready", () => {
    expect(
      chatHistoryPagerContentSized(chatHistoryPagerState(), {
        ...ask,
        metrics: short,
        pendingStartLine: -640,
      }).request,
    ).toBeNull();
    expect(
      chatHistoryPagerContentSized(chatHistoryPagerState(), {
        ...ask,
        ready: false,
        metrics: short,
      }).request,
    ).toBeNull();
  });

  it("stays quiet once the floor is known", () => {
    const atFloor = { ...chatHistoryPagerState(), floorReached: true };
    expect(chatHistoryPagerContentSized(atFloor, { ...ask, metrics: short }).request).toBeNull();
  });

  it("leaves the scroll pager free to keep going", () => {
    // The latch is for this trigger only: once there IS something to scroll,
    // the gesture path has its own rules and its own retry brake.
    const filled = chatHistoryPagerContentSized(chatHistoryPagerState(), {
      ...ask,
      metrics: short,
    }).state;
    const scrolled = chatHistoryPagerScrolled(filled, { ...ask, metrics: { ...tall, offsetY: 0 } });
    expect(scrolled.request).not.toBeNull();
  });
});
