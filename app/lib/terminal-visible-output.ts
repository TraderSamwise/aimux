import type { ChatScrollIntent } from "@/lib/chat-scroll-policy";

export type TerminalVisibleOutput<TLine> = {
  lines: readonly TLine[];
  outputAvailable: boolean;
  outputText: string;
  sessionKey: string;
};

export function terminalVisibleOutputForPinned<TLine>(input: {
  lines: readonly TLine[];
  outputAvailable: boolean;
  outputText: string;
  sessionKey: string;
}): TerminalVisibleOutput<TLine> {
  return input;
}

export function terminalVisibleOutputForLiveChange<TLine>(
  current: TerminalVisibleOutput<TLine>,
  {
    intent,
    liveOutput,
  }: {
    intent: ChatScrollIntent;
    liveOutput: TerminalVisibleOutput<TLine>;
  },
): TerminalVisibleOutput<TLine> {
  if (current.sessionKey !== liveOutput.sessionKey || intent === "pinned") return liveOutput;
  return current;
}
