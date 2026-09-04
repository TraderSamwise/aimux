import { describe, expect, it } from "vitest";

import {
  paneOutputSnapshotHasVisibleTranscript,
  shouldForceNativePinnedChatOffset,
  shouldHydrateTerminalOutput,
} from "./chat-loading";

describe("paneOutputSnapshotHasVisibleTranscript", () => {
  it("keeps the initial transcript loader visible for fast empty snapshots", () => {
    expect(
      paneOutputSnapshotHasVisibleTranscript({
        messages: [],
        output: "",
        outputAnsi: "",
      }),
    ).toBe(false);
  });

  it("treats projected messages or terminal bytes as visible transcript content", () => {
    expect(paneOutputSnapshotHasVisibleTranscript({ messages: [{ id: "m1" }] })).toBe(true);
    expect(paneOutputSnapshotHasVisibleTranscript({ messages: [], output: "ready" })).toBe(true);
    expect(
      paneOutputSnapshotHasVisibleTranscript({ messages: [], outputAnsi: "\u001b[32mok" }),
    ).toBe(true);
    expect(paneOutputSnapshotHasVisibleTranscript({ messages: [], outputAvailable: true })).toBe(
      true,
    );
  });
});

describe("shouldForceNativePinnedChatOffset", () => {
  it("does not override keyboard-controller offsets while the native keyboard is visible", () => {
    expect(
      shouldForceNativePinnedChatOffset({
        keyboardVisible: true,
        pinnedToEnd: true,
      }),
    ).toBe(false);
  });

  it("keeps the native chat pinned when the keyboard is closed", () => {
    expect(
      shouldForceNativePinnedChatOffset({
        keyboardVisible: false,
        pinnedToEnd: true,
      }),
    ).toBe(true);
    expect(
      shouldForceNativePinnedChatOffset({
        keyboardVisible: false,
        pinnedToEnd: false,
      }),
    ).toBe(false);
  });
});

describe("shouldHydrateTerminalOutput", () => {
  it("hydrates terminal mode whenever terminal output is available", () => {
    expect(
      shouldHydrateTerminalOutput({
        outputAvailable: true,
        terminalViewVisible: true,
      }),
    ).toBe(true);
  });

  it("does not hydrate when terminal mode is hidden or output is unavailable", () => {
    expect(
      shouldHydrateTerminalOutput({
        outputAvailable: false,
        terminalViewVisible: true,
      }),
    ).toBe(false);
    expect(
      shouldHydrateTerminalOutput({
        outputAvailable: true,
        terminalViewVisible: false,
      }),
    ).toBe(false);
  });
});
