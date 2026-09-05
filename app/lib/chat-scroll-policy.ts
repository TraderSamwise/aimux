export type ChatScrollIntent = "pinned" | "reading";

export type ChatScrollMetrics = {
  contentHeight: number;
  offsetY: number;
  viewportHeight: number;
};

export type ChatScrollPolicy = {
  intent: ChatScrollIntent;
};

export type ChatScrollCommand =
  | {
      animated: boolean;
      kind: "scrollToEnd";
      reason: "content" | "initial" | "keyboard" | "navigation";
    }
  | { kind: "none" };

export const CHAT_SCROLL_END_THRESHOLD = 36;

export function createChatScrollPolicy(): ChatScrollPolicy {
  return { intent: "pinned" };
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
