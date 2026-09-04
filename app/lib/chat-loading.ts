export type PaneOutputSnapshotContent = {
  messages?: readonly unknown[];
  output?: string | null;
  outputAnsi?: string | null;
  outputAvailable?: boolean | null;
};

export function paneOutputSnapshotHasVisibleTranscript(result: PaneOutputSnapshotContent): boolean {
  return Boolean(
    (Array.isArray(result.messages) && result.messages.length > 0) ||
    result.output?.length ||
    result.outputAnsi?.length ||
    result.outputAvailable,
  );
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
