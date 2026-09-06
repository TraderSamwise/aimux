import type { InitialAgentOutputFeedStatus } from "@/lib/agent-output-feed-state";

export type PaneOutputSnapshotContent = {
  messages?: readonly unknown[];
  output?: string | null;
  outputAnsi?: string | null;
  outputAvailable?: boolean | null;
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
  return Array.isArray(result.messages) || paneOutputSnapshotHasVisibleTranscript(result);
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
  if (lastError) {
    return {
      kind: "error",
      title: "Transcript unavailable",
      message: lastError,
      retryLabel: "Retry",
    };
  }
  if (initialStatus === "loading") {
    return {
      kind: "loading",
      title: "Loading transcript",
      message: "Waiting for chat history from the project service.",
    };
  }
  if (initialStatus === "timed-out") {
    return {
      kind: "timed-out",
      title: "Still loading transcript",
      message: "The project service has not returned chat history yet.",
      retryLabel: "Retry",
    };
  }
  return {
    kind: "empty",
    title: "No chat transcript yet",
    message: "New messages will appear here.",
  };
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
