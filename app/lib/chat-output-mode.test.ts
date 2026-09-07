import { describe, expect, it } from "vitest";

import {
  CHAT_SPLIT_VIEW_MIN_WIDTH,
  canUseChatSplitView,
  chatOutputPaneVisibility,
  effectiveChatOutputViewMode,
} from "./chat-output-mode";

describe("chat output mode", () => {
  it("makes split capability a viewport-width decision", () => {
    expect(canUseChatSplitView(CHAT_SPLIT_VIEW_MIN_WIDTH - 1)).toBe(false);
    expect(canUseChatSplitView(CHAT_SPLIT_VIEW_MIN_WIDTH)).toBe(true);
  });

  it("falls split back to chat on narrow viewports", () => {
    expect(effectiveChatOutputViewMode({ mode: "split", rawOutputAllowed: true, width: 430 })).toBe(
      "chat",
    );
    expect(effectiveChatOutputViewMode({ mode: "split", rawOutputAllowed: true, width: 900 })).toBe(
      "split",
    );
  });

  it("keeps terminal visible independent of split width", () => {
    expect(
      chatOutputPaneVisibility({ mode: "terminal", rawOutputAllowed: true, width: 430 }),
    ).toEqual({
      chatViewVisible: false,
      effectiveMode: "terminal",
      terminalViewVisible: true,
    });
  });

  it("forces shared or receiver-only chats to chat mode", () => {
    expect(
      chatOutputPaneVisibility({ mode: "terminal", rawOutputAllowed: false, width: 1200 }),
    ).toEqual({
      chatViewVisible: true,
      effectiveMode: "chat",
      terminalViewVisible: false,
    });
  });
});
