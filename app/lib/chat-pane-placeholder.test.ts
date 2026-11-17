import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CHAT_PANE_PLACEHOLDER_SHELL } from "./chat-pane-placeholder";

const SCREEN = readFileSync(
  join(__dirname, "..", "components", "screens", "AgentChatScreen.tsx"),
  "utf8",
);

describe("the chat pane placeholder shell", () => {
  it("grows, which is what lets it centre", () => {
    // Both panes scroll with `flexGrow: 1` and `justifyContent: "flex-end"`.
    // Without `flex-1` the shell is content-height and that `flex-end` drops
    // it to the bottom of the pane; `justify-center` then centres nothing.
    // This is the bug: the terminal card sank while the transcript card
    // centred.
    expect(CHAT_PANE_PLACEHOLDER_SHELL).toContain("flex-1");
    expect(CHAT_PANE_PLACEHOLDER_SHELL).toContain("justify-center");
  });

  it("is what both panes use", () => {
    // Split mode shows both cards at once, so a difference between them is
    // visible side by side. Two call sites, one constant.
    const uses = SCREEN.match(/className=\{CHAT_PANE_PLACEHOLDER_SHELL\}/g) ?? [];
    expect(uses.length).toBe(2);
  });

  it("leaves no pane placeholder spelling its own centring", () => {
    // The literal both call sites used to carry. If it comes back, one pane
    // has its own answer again and they can differ by a single class.
    expect(SCREEN).not.toMatch(/items-center justify-center px-4 py-10/);
  });
});
