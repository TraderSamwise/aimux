import type { AgentOutputViewMode } from "@/stores/settings";

export const CHAT_SPLIT_VIEW_MIN_WIDTH = 900;

export function canUseChatSplitView(width: number): boolean {
  return width >= CHAT_SPLIT_VIEW_MIN_WIDTH;
}

export function effectiveChatOutputViewMode({
  rawOutputAllowed,
  mode,
  width,
}: {
  mode: AgentOutputViewMode;
  rawOutputAllowed: boolean;
  width: number;
}): AgentOutputViewMode {
  if (!rawOutputAllowed && mode !== "chat") return "chat";
  return mode === "split" && !canUseChatSplitView(width) ? "chat" : mode;
}

export function chatOutputPaneVisibility({
  rawOutputAllowed,
  mode,
  width,
}: {
  mode: AgentOutputViewMode;
  rawOutputAllowed: boolean;
  width: number;
}): {
  chatViewVisible: boolean;
  effectiveMode: AgentOutputViewMode;
  terminalViewVisible: boolean;
} {
  const effectiveMode = effectiveChatOutputViewMode({ rawOutputAllowed, mode, width });
  return {
    chatViewVisible: effectiveMode !== "terminal",
    effectiveMode,
    terminalViewVisible: effectiveMode === "split" || effectiveMode === "terminal",
  };
}
