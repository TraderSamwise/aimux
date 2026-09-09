export type ChatScrollIntent = "pinned" | "reading";
export type ChatScrollDirection = "none" | "towardHistory" | "towardNewest";

export type ChatScrollMetrics = {
  contentHeight: number;
  offsetY: number;
  viewportHeight: number;
};

export type ChatScrollPolicy = {
  intent: ChatScrollIntent;
};

export type ChatScrollChromeState = {
  lastOffsetY: number | null;
  visible: boolean;
};

export type ChatScrollCommand =
  | {
      animated: boolean;
      kind: "scrollToEnd";
      reason: "content" | "initial" | "keyboard" | "navigation";
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

export function chatDistanceFromEnd(metrics: ChatScrollMetrics): number {
  const scrollableHeight = Math.max(0, metrics.contentHeight - metrics.viewportHeight);
  return Math.max(0, scrollableHeight - Math.max(0, metrics.offsetY));
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
