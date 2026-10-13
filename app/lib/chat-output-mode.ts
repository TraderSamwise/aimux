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
    // An allowlist, not `!== "terminal"`. As a denylist every mode added
    // later was assumed to render the chat transcript, so a new pane would
    // get no send confirmation and the cross-surface gate would pass
    // vacuously -- which is exactly how terminal mode ended up with none.
    chatViewVisible: effectiveMode === "chat" || effectiveMode === "split",
    effectiveMode,
    terminalViewVisible: effectiveMode === "split" || effectiveMode === "terminal",
  };
}
