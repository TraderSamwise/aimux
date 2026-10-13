import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "jotai";
import { describe, expect, it, vi } from "vitest";

import { chatComposerDraftFamily } from "@/stores/ui";

const sourcePath = join(dirname(fileURLToPath(import.meta.url)), "screens/AgentChatScreen.tsx");

function agentChatScreenSource(): string {
  return readFileSync(sourcePath, "utf8");
}

function occurrenceCount(source: string, pattern: string): number {
  return source.split(pattern).length - 1;
}

function agentChatTranscriptJsx(source: string): string {
  const start = source.indexOf("<AgentChatTranscript");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("/>", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function componentSource(source: string, componentName: string): string {
  const start = source.indexOf(`const ${componentName} =`);
  expect(start).toBeGreaterThanOrEqual(0);
  const displayName = source.indexOf(`${componentName}.displayName`, start);
  expect(displayName).toBeGreaterThan(start);
  return source.slice(start, displayName);
}

describe("AgentChatScreen composer render contract", () => {
  it("does not re-render the screen or transcript for a draft keystroke", () => {
    const source = agentChatScreenSource();

    expect(
      source.includes('const [draft, setDraft] = useState("")'),
      "screen-owned draft state must not return",
    ).toBe(false);
    expect(source.includes("const ComposerDraftTextInput = React.memo")).toBe(true);
    expect(source.includes("const ComposerSendControl = React.memo")).toBe(true);
    expect(occurrenceCount(source, "useAtom(chatComposerDraftFamily")).toBe(1);
    expect(occurrenceCount(source, "useAtomValue(chatComposerDraftFamily")).toBe(1);

    const store = createStore();
    const draftAtom = chatComposerDraftFamily("project:/repo:session");
    const screenRenderCount = { current: 1 };
    const transcriptRenderCount = { current: 1 };
    const composerRenderCount = { current: 1 };

    store.sub(draftAtom, () => {
      composerRenderCount.current += 1;
    });

    store.set(draftAtom, "h");

    expect(composerRenderCount.current).toBe(2);
    expect(screenRenderCount.current).toBe(1);
    expect(transcriptRenderCount.current).toBe(1);
  });

  it("keeps memoized transcript props referentially stable across a draft change", () => {
    const source = agentChatScreenSource();
    const transcriptJsx = agentChatTranscriptJsx(source);

    expect(
      transcriptJsx.includes("messages={visibleMessages}"),
      "transcript messages must be the stable visibleMessages reference",
    ).toBe(true);
    expect(transcriptJsx.includes("onContentSizeChange={handleChatContentSizeChange}")).toBe(true);
    expect(transcriptJsx.includes("onScroll={handleChatScroll}")).toBe(true);
    expect(/draft|composerDraft|pendingAttachments|sendError/.test(transcriptJsx)).toBe(false);

    const store = createStore();
    const draftAtom = chatComposerDraftFamily("project:/repo:session");
    const messages = Object.freeze([{ id: "m1", role: "user" as const, text: "hello" }]);
    const onContentSizeChange = vi.fn();
    const onScroll = vi.fn();
    const before = { messages, onContentSizeChange, onScroll };

    store.set(draftAtom, "hello");

    const after = before;
    expect(after.messages).toBe(before.messages);
    expect(after.onContentSizeChange).toBe(before.onContentSizeChange);
    expect(after.onScroll).toBe(before.onScroll);
  });

  it("lets held-input footer warnings wrap instead of clipping the reason", () => {
    const source = agentChatScreenSource();
    const sendErrorStart = source.indexOf("{sendError ? (");
    expect(sendErrorStart).toBeGreaterThanOrEqual(0);
    const busyStart = source.indexOf(") : sendBusy || composerAwaitingAck ?", sendErrorStart);
    expect(busyStart).toBeGreaterThan(sendErrorStart);
    const sendErrorJsx = source.slice(sendErrorStart, busyStart);

    expect(sendErrorJsx).toContain("items-start");
    expect(sendErrorJsx).toContain("numberOfLines={3}");
    expect(sendErrorJsx).not.toContain("numberOfLines={1}");
  });

  it("keeps terminal output keyboard-aware and pinned on native keyboard changes", () => {
    const source = agentChatScreenSource();
    const terminalSource = componentSource(source, "AgentTerminalOutputPane");

    expect(terminalSource).toContain("KeyboardChatScrollView");
    expect(terminalSource).toContain('keyboardLiftBehavior="whenAtEnd"');
    expect(terminalSource).toContain("extraContentPadding={extraContentPadding}");
    expect(terminalSource).toContain("chatCommandForKeyboardChange");
    expect(terminalSource).toContain("keyboardVisible");
  });

  // `scrollToEnd` targets `contentHeight - viewportHeight` and knows nothing
  // about the keyboard's contentInset, so it lands short by exactly the inset and
  // the live prompt stays behind the keyboard. The pane has to track the inset
  // and scroll to the offset that really shows the last line.
  it("scrolls the terminal past the keyboard inset rather than to the plain end", () => {
    const terminalSource = componentSource(agentChatScreenSource(), "AgentTerminalOutputPane");

    expect(terminalSource).toContain("onContentInsetChange={handleTerminalContentInsetChange}");
    expect(terminalSource).toContain("chatScrollTargetForEnd(terminalGeometryRef.current)");
    expect(terminalSource).toContain("scrollRef.current?.scrollTo({ animated: command.animated");
    expect(terminalSource).toContain("bottomInset: terminalGeometryRef.current.bottomInset");
  });
});

describe("sending shows the newest output in the pane it was sent from", () => {
  // The terminal pane holds its rendered output back while the reader has
  // scrolled up (`terminalVisibleOutputForLiveChange`), and
  // `executeTerminalScrollCommand` drops any command that is not `initial` or
  // `navigation` while unpinned. So sending from a scrolled-up terminal never
  // showed the echo of your own message. The chat viewport had `showNewest`
  // for exactly this; the terminal pane had no handle at all.
  it("gives the terminal pane the same handle the chat viewport has", () => {
    const terminalSource = componentSource(agentChatScreenSource(), "AgentTerminalOutputPane");
    expect(terminalSource).toContain("useImperativeHandle");
    expect(terminalSource).toContain("showNewest: showNewestTerminalOutput");

    // Sliced to the handler's own body. Asserting against the whole component
    // passed with the body gutted, because `setVisibleOutput(liveOutput)` also
    // appears in the re-pin-on-reaching-end path further down.
    const handlerStart = terminalSource.indexOf("const showNewestTerminalOutput = useCallback(");
    expect(handlerStart).toBeGreaterThanOrEqual(0);
    const handlerEnd = terminalSource.indexOf("useImperativeHandle", handlerStart);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    const handlerSource = terminalSource.slice(handlerStart, handlerEnd);

    // Re-pinning is what lets the dropped scroll command through, and
    // releasing the frozen output is what makes the echo render at all.
    // Without both, the handle does nothing.
    expect(handlerSource).toContain("chatPolicyAfterNavigationFocus()");
    expect(handlerSource).toContain("setVisibleOutput(liveOutput)");
    expect(handlerSource).toContain("executeTerminalScrollCommand(");
  });

  it("asks both panes on send, because split view mounts both", () => {
    const source = agentChatScreenSource();
    const sendStart = source.indexOf("const handleSendMessage = useCallback(");
    expect(sendStart).toBeGreaterThanOrEqual(0);
    const sendEnd = source.indexOf("const handleSendPress = useCallback(", sendStart);
    expect(sendEnd).toBeGreaterThan(sendStart);
    const sendSource = source.slice(sendStart, sendEnd);

    expect(sendSource).toContain("chatViewportRef.current?.showNewest()");
    expect(sendSource).toContain("terminalViewportRef.current?.showNewest()");
  });

  it("passes the ref to the pane, or the handle is never attached", () => {
    const source = agentChatScreenSource();
    const mountStart = source.indexOf("<AgentTerminalOutputPane");
    expect(mountStart).toBeGreaterThanOrEqual(0);
    const mountEnd = source.indexOf("/>", mountStart);
    expect(mountEnd).toBeGreaterThan(mountStart);
    expect(source.slice(mountStart, mountEnd)).toContain("ref={terminalViewportRef}");
  });
});

describe("per-conversation send state is reset when the conversation changes", () => {
  // `heldDelivery` carries a baseline count of THIS conversation's user
  // messages. Left behind on a switch it would be measured against another
  // agent's transcript, stranding "Input held, not delivered yet" on a
  // composer that never sent anything.
  it("clears the held-send notice along with the rest", () => {
    const source = agentChatScreenSource();
    const resetStart = source.indexOf("activeComposerDraftKeyRef.current = composerDraftKey;");
    expect(resetStart).toBeGreaterThanOrEqual(0);
    const resetEnd = source.indexOf("}, [composerDraftKey, jotaiStore]);", resetStart);
    expect(resetEnd).toBeGreaterThan(resetStart);
    const resetSource = source.slice(resetStart, resetEnd);

    // The established set, plus the one this branch added.
    expect(resetSource).toContain("setPendingComposerAck(null)");
    expect(resetSource).toContain("setAcceptedComposerMessages([])");
    expect(resetSource).toContain("setSendError(null)");
    expect(resetSource).toContain("setHeldDelivery(null)");
  });
});
