import {
  chatChromeAfterUserScroll,
  chatPolicyAfterUserScroll,
  type ChatScrollChromeState,
  type ChatScrollIntent,
  type ChatScrollMetrics,
  type ChatScrollPolicy,
} from "@/lib/chat-scroll-policy";

export type TerminalVisibleOutput<TLine> = {
  lines: readonly TLine[];
  outputAvailable: boolean;
  outputText: string;
  sessionKey: string;
  /**
   * The column count these lines were truncated at.
   *
   * The freeze below is about CONTENT -- it holds the view still while
   * someone reads. Geometry is not content: rotating the phone or narrowing
   * the browser re-truncates every rule without changing a byte of
   * `outputText`, so without this the frozen lines keep the old width and
   * every rule wraps until the reader scrolls back to the bottom. That is
   * the original bug, reappearing in the one state where it is hardest to
   * escape.
   */
  columns: number;
};

export function terminalVisibleOutputForPinned<TLine>(input: {
  lines: readonly TLine[];
  outputAvailable: boolean;
  outputText: string;
  sessionKey: string;
  columns: number;
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
  // A different width is a different rendering of the same bytes, so the
  // content freeze has nothing to say about it.
  if (current.columns !== liveOutput.columns) return liveOutput;
  if (current.outputText.length === 0) return liveOutput;
  // A history page deepens the window, and the snapshot it arrives in is the
  // whole window as of the fetch -- so a working agent's page is deeper at the
  // top and longer at the bottom at once. Finding the frozen tail at a
  // non-zero offset is what says "something was prepended", and it holds
  // whether or not the bottom grew too; a suffix test only recognised the
  // idle case, which is not a case anyone scrolls back through. Offset zero is
  // ordinary live growth and stays frozen, which is the freeze this whole
  // function exists for.
  if (liveOutput.outputText.length > current.outputText.length) {
    const frozenTailAt = liveOutput.outputText.indexOf(current.outputText);
    if (frozenTailAt > 0) return liveOutput;
  }
  return current;
}

export function terminalScrollStateAfterUserScroll({
  chrome,
  metrics,
  policy,
}: {
  chrome: ChatScrollChromeState;
  metrics: ChatScrollMetrics;
  policy: ChatScrollPolicy;
}): {
  chrome: ChatScrollChromeState;
  policy: ChatScrollPolicy;
} {
  const nextPolicy = chatPolicyAfterUserScroll(policy, metrics);
  return {
    chrome: chatChromeAfterUserScroll(chrome, nextPolicy, metrics),
    policy: nextPolicy,
  };
}
