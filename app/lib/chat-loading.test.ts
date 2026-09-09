import { describe, expect, it } from "vitest";

import {
  agentOutputModeForVisiblePane,
  chatTranscriptPlaceholderState,
  paneOutputSnapshotSettlesInitialTranscript,
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

describe("paneOutputSnapshotSettlesInitialTranscript", () => {
  it("settles initial loading once the service projects transcript messages, even when empty", () => {
    expect(paneOutputSnapshotSettlesInitialTranscript({ messages: [] })).toBe(true);
    expect(paneOutputSnapshotSettlesInitialTranscript({ messages: [{ id: "m1" }] })).toBe(true);
  });

  it("does not settle initial loading when no transcript projection or terminal output arrived", () => {
    expect(paneOutputSnapshotSettlesInitialTranscript({})).toBe(false);
    expect(
      paneOutputSnapshotSettlesInitialTranscript({
        output: "",
        outputAnsi: "",
      }),
    ).toBe(false);
  });

  it("settles initial loading for terminal output fallback content", () => {
    expect(paneOutputSnapshotSettlesInitialTranscript({ output: "ready" })).toBe(true);
    expect(paneOutputSnapshotSettlesInitialTranscript({ outputAvailable: true })).toBe(true);
  });
});

describe("chatTranscriptPlaceholderState", () => {
  it("does not show a placeholder once messages are visible", () => {
    expect(
      chatTranscriptPlaceholderState({
        initialStatus: "loading",
        lastError: "service unavailable",
        messageCount: 1,
      }),
    ).toEqual({ kind: "none" });
  });

  it("shows the initial transcript loader while the first chat snapshot is pending", () => {
    expect(
      chatTranscriptPlaceholderState({
        initialStatus: "loading",
        lastError: null,
        messageCount: 0,
      }),
    ).toMatchObject({
      kind: "loading",
      title: "Loading transcript",
    });
  });

  it("shows a retryable timeout after the initial transcript load takes too long", () => {
    expect(
      chatTranscriptPlaceholderState({
        initialStatus: "timed-out",
        lastError: null,
        messageCount: 0,
      }),
    ).toMatchObject({
      kind: "timed-out",
      retryLabel: "Retry",
    });
  });

  it("shows a retryable error when the transcript feed reports a failure", () => {
    expect(
      chatTranscriptPlaceholderState({
        initialStatus: "idle",
        lastError: "request timed out",
        messageCount: 0,
      }),
    ).toEqual({
      kind: "error",
      title: "Transcript unavailable",
      message: "request timed out",
      retryLabel: "Retry",
    });
  });

  it("shows an empty transcript state only after loading has settled cleanly", () => {
    expect(
      chatTranscriptPlaceholderState({
        initialStatus: "idle",
        lastError: null,
        messageCount: 0,
      }),
    ).toMatchObject({
      kind: "empty",
      title: "No chat transcript yet",
    });
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

describe("agentOutputModeForVisiblePane", () => {
  it("uses full output while terminal or split mode is visible", () => {
    expect(agentOutputModeForVisiblePane({ terminalViewVisible: true })).toBe("full");
  });

  it("uses projected chat output while terminal mode is hidden", () => {
    expect(agentOutputModeForVisiblePane({ terminalViewVisible: false })).toBe("chat");
  });
});
