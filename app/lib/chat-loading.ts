import type { InitialAgentOutputFeedStatus } from "@/lib/agent-output-feed-state";
import { isTransientRequestError } from "@/lib/request-errors";

export type PaneOutputSnapshotContent = {
  messages?: readonly unknown[];
  output?: string | null;
  outputAnsi?: string | null;
  outputAvailable?: boolean | null;
  tmuxUnavailable?: unknown;
};

export type ChatTranscriptPlaceholderState =
  | { kind: "none" }
  | { kind: "loading"; message: string; title: string }
  | { kind: "timed-out"; message: string; retryLabel: string; title: string }
  | { kind: "error"; message: string; retryLabel: string; title: string }
  | { kind: "empty"; message: string; title: string };

export function paneOutputSnapshotHasVisibleTranscript(result: PaneOutputSnapshotContent): boolean {
  return Boolean(
    (Array.isArray(result.messages) && result.messages.length > 0) ||
    result.output?.length ||
    result.outputAnsi?.length ||
    result.outputAvailable,
  );
}

export function paneOutputSnapshotSettlesInitialTranscript(
  result: PaneOutputSnapshotContent,
): boolean {
  return (
    Array.isArray(result.messages) ||
    Boolean(result.tmuxUnavailable) ||
    paneOutputSnapshotHasVisibleTranscript(result)
  );
}

/** The two panes that render the same session's data side by side. */
export type AgentPaneSurface = "chat" | "terminal";

const PANE_COPY = {
  chat: {
    errorTitle: "Transcript unavailable",
    loadingTitle: "Loading transcript",
    loadingMessage: "Waiting for chat history from the project service.",
    timedOutTitle: "Still loading transcript",
    timedOutMessage: "The project service has not returned chat history yet.",
    emptyTitle: "No chat transcript yet",
    emptyMessage: "New messages will appear here.",
  },
  terminal: {
    errorTitle: "Output unavailable",
    loadingTitle: "Loading output",
    loadingMessage: "Waiting for terminal output from the project service.",
    timedOutTitle: "Still loading output",
    timedOutMessage: "The project service has not returned terminal output yet.",
    emptyTitle: "No terminal output yet",
    emptyMessage: "Output will appear here.",
  },
} as const;

/**
 * What a pane should show, for either pane, from one decision.
 *
 * The chat pane and the terminal pane render the same session's data from the
 * same feed, so when they classify it separately they agree only by luck. They
 * did not: the chat pane said "Transcript unavailable -- Daemon connection
 * replaced" with a Retry button while the terminal pane spun "Loading output"
 * for ever, describing one dead connection as two different situations, and
 * only one of them was actionable.
 *
 * Only the WORDS differ per surface. The kind -- loading, timed out, error,
 * empty -- is decided once here, which is the part a reader compares.
 */
export function agentPanePlaceholderState(
  surface: AgentPaneSurface,
  {
    initialStatus,
    lastError,
    hasContent,
  }: {
    initialStatus: InitialAgentOutputFeedStatus;
    lastError: string | null;
    hasContent: boolean;
  },
): ChatTranscriptPlaceholderState {
  const copy = PANE_COPY[surface];
  if (hasContent) return { kind: "none" };
  if (lastError && !(initialStatus === "loading" && isTransientRequestError(lastError))) {
    return { kind: "error", title: copy.errorTitle, message: lastError, retryLabel: "Retry" };
  }
  if (initialStatus === "loading") {
    return { kind: "loading", title: copy.loadingTitle, message: copy.loadingMessage };
  }
  if (initialStatus === "timed-out") {
    return {
      kind: "timed-out",
      title: copy.timedOutTitle,
      message: copy.timedOutMessage,
      retryLabel: "Retry",
    };
  }
  return { kind: "empty", title: copy.emptyTitle, message: copy.emptyMessage };
}

/** The terminal pane's half of the same answer. */
export function terminalOutputPlaceholderState(input: {
  initialStatus: InitialAgentOutputFeedStatus;
  lastError: string | null;
  hasOutput: boolean;
}): ChatTranscriptPlaceholderState {
  return agentPanePlaceholderState("terminal", {
    initialStatus: input.initialStatus,
    lastError: input.lastError,
    hasContent: input.hasOutput,
  });
}

export function chatTranscriptPlaceholderState({
  initialStatus,
  lastError,
  messageCount,
}: {
  initialStatus: InitialAgentOutputFeedStatus;
  lastError: string | null;
  messageCount: number;
}): ChatTranscriptPlaceholderState {
  if (messageCount > 0) return { kind: "none" };
  // A blip while the first load is still in flight is not a failure yet.
  //
  // `lastError` used to win outright, so opening a shared chat showed
  // "Transcript unavailable -- Relay not connected" with a Retry button, and
  // then loaded by itself a moment later: the first request had landed in
  // one of the relay's dead windows while the connection was flapping, and
  // the retry nobody pressed succeeded. The reader was asked to act on
  // something that was already fixing itself.
  //
  // Only while loading, and only for the errors the app already classes as
  // transient. A real failure -- a 500, a session that no longer exists --
  // still shows the moment it arrives rather than hiding behind a spinner,
  // and once the load stops being in flight a transient error surfaces too,
  // because by then it has genuinely failed.
  //
  // That reasoning lives in `agentPanePlaceholderState` now, so the terminal
  // pane gets it too rather than spinning through the same failure.
  return agentPanePlaceholderState("chat", { initialStatus, lastError, hasContent: false });
}

export function shouldForceNativePinnedChatOffset({
  keyboardVisible,
  pinnedToEnd,
}: {
  keyboardVisible: boolean;
  pinnedToEnd: boolean;
}): boolean {
  return pinnedToEnd && !keyboardVisible;
}

export function shouldHydrateTerminalOutput({
  outputAvailable,
  terminalViewVisible,
}: {
  outputAvailable: boolean;
  terminalViewVisible: boolean;
}): boolean {
  return terminalViewVisible && outputAvailable;
}

export function agentOutputModeForVisiblePane({
  terminalViewVisible,
}: {
  terminalViewVisible: boolean;
}): "full" | "chat" {
  return terminalViewVisible ? "full" : "chat";
}
