export type ChatScrollIntent = "pinned" | "reading";
export type ChatScrollDirection = "none" | "towardHistory" | "towardNewest";

export type ChatScrollMetrics = {
  contentHeight: number;
  offsetY: number;
  viewportHeight: number;
  // The keyboard-driven bottom contentInset. It extends the scrollable range
  // past the content, so the end of the content is only reachable at
  // `contentHeight - viewportHeight + bottomInset`. Leaving it out is what left
  // the newest terminal output sitting behind the keyboard: the pane believed
  // it was at the end while the live prompt was still below the fold.
  bottomInset?: number;
};

export type ChatScrollPolicy = {
  intent: ChatScrollIntent;
};

export type ChatScrollChromeState = {
  lastOffsetY: number | null;
  visible: boolean;
};

export type ChatScrollReason = "content" | "initial" | "keyboard" | "navigation";

export type ChatScrollCommand =
  | {
      animated: boolean;
      kind: "scrollToEnd";
      reason: ChatScrollReason;
    }
  | { kind: "none" };

export const CHAT_SCROLL_END_THRESHOLD = 20;
export const CHAT_SCROLL_DIRECTION_THRESHOLD = 6;

export function createChatScrollPolicy(): ChatScrollPolicy {
  return { intent: "pinned" };
}

export function createChatScrollChromeState(): ChatScrollChromeState {
  return { lastOffsetY: null, visible: true };
}

// The offset that actually puts the last line against the bottom of the
// viewport. `scrollToEnd` does not know about the keyboard inset, so a pane that
// wants the newest line visible has to scroll here instead.
export function chatScrollTargetForEnd(metrics: ChatScrollMetrics): number {
  return Math.max(
    0,
    metrics.contentHeight - metrics.viewportHeight + Math.max(0, metrics.bottomInset ?? 0),
  );
}

/**
 * Where to scroll to put the newest content on screen, or null if we cannot
 * know yet.
 *
 * Null is the honest answer before the pane has been measured: a mounted
 * viewport starts at zero everywhere, and the library reports the keyboard and
 * composer inset through its own callback, so the inset can arrive first. A
 * pane that trusted `target > 0` then scrolled to the INSET -- a couple of
 * hundred points from the top of the history -- which is worse than the short
 * landing it was meant to fix. `scrollToEnd` is the right fallback while
 * nothing is measured, because the native command knows the content even when
 * we do not.
 */
export function chatScrollEndOffset(metrics: ChatScrollMetrics): number | null {
  if (metrics.contentHeight <= 0 || metrics.viewportHeight <= 0) return null;
  const target = chatScrollTargetForEnd(metrics);
  return target > 0 ? target : null;
}

export function chatDistanceFromEnd(metrics: ChatScrollMetrics): number {
  return Math.max(0, chatScrollTargetForEnd(metrics) - Math.max(0, metrics.offsetY));
}

export function isChatPinnedToEnd(
  metrics: ChatScrollMetrics,
  threshold = CHAT_SCROLL_END_THRESHOLD,
): boolean {
  return chatDistanceFromEnd(metrics) <= threshold;
}

export function chatPolicyAfterUserScroll(
  policy: ChatScrollPolicy,
  metrics: ChatScrollMetrics,
): ChatScrollPolicy {
  const nextIntent: ChatScrollIntent = isChatPinnedToEnd(metrics) ? "pinned" : "reading";
  return nextIntent === policy.intent ? policy : { intent: nextIntent };
}

export function chatScrollDirection(
  previousOffsetY: number | null,
  offsetY: number,
  threshold = CHAT_SCROLL_DIRECTION_THRESHOLD,
): ChatScrollDirection {
  if (previousOffsetY === null) return "none";
  if (offsetY < previousOffsetY - threshold) return "towardHistory";
  if (offsetY > previousOffsetY + threshold) return "towardNewest";
  return "none";
}

export function chatChromeAfterUserScroll(
  state: ChatScrollChromeState,
  policy: ChatScrollPolicy,
  metrics: ChatScrollMetrics,
): ChatScrollChromeState {
  if (policy.intent === "pinned" || isChatPinnedToEnd(metrics)) {
    return { lastOffsetY: metrics.offsetY, visible: true };
  }

  const direction = chatScrollDirection(state.lastOffsetY, metrics.offsetY);
  if (direction === "towardHistory") return { lastOffsetY: metrics.offsetY, visible: false };
  if (direction === "towardNewest") return { lastOffsetY: metrics.offsetY, visible: true };
  return state.lastOffsetY === metrics.offsetY ? state : { ...state, lastOffsetY: metrics.offsetY };
}

export function chatPolicyAfterNavigationFocus(): ChatScrollPolicy {
  return { intent: "pinned" };
}

export function chatCommandForContentChange(policy: ChatScrollPolicy): ChatScrollCommand {
  if (policy.intent !== "pinned") return { kind: "none" };
  return { animated: false, kind: "scrollToEnd", reason: "content" };
}

export function chatCommandForKeyboardChange(policy: ChatScrollPolicy): ChatScrollCommand {
  if (policy.intent !== "pinned") return { kind: "none" };
  return { animated: false, kind: "scrollToEnd", reason: "keyboard" };
}

export function chatCommandForNavigationFocus(): ChatScrollCommand {
  return { animated: false, kind: "scrollToEnd", reason: "navigation" };
}

export function chatCommandForInitialLayout(): ChatScrollCommand {
  return { animated: false, kind: "scrollToEnd", reason: "initial" };
}

/**
 * Whether a command still runs once the reader has scrolled away.
 *
 * Opening a chat and landing on it are not negotiable: the first layout and a
 * navigation focus put the newest message on screen whatever the intent says.
 * Everything else is an offer the reader can refuse by scrolling up.
 *
 * Both panes used to spell this out inside their own `requestAnimationFrame`
 * and then cancel the queued command from their scroll handler regardless --
 * so a single stray scroll event killed the very scroll that was taking the
 * reader to the bottom, which is how a chat opened mid-history.
 */
export function chatScrollCommandRunsWhileUnpinned(reason: ChatScrollReason | null): boolean {
  return reason === "initial" || reason === "navigation";
}
