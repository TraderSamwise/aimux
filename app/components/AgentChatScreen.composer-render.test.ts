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
    // The footer's precedence moved into `composerFooterState` and its
    // rendering into `ComposerFooterContentView`, so this reads the error case
    // of that component rather than a ternary that no longer exists. The
    // property is the same one: a held-input reason is a sentence and has to
    // wrap rather than clip to one line.
    const source = agentChatScreenSource();
    const viewStart = source.indexOf("function ComposerFooterContentView(");
    expect(viewStart).toBeGreaterThanOrEqual(0);
    const viewEnd = source.indexOf("\nfunction ", viewStart + 1);
    expect(viewEnd).toBeGreaterThan(viewStart);
    const view = source.slice(viewStart, viewEnd);
    const errorCase = view.slice(view.indexOf('case "error":'), view.indexOf('case "held":'));
    expect(errorCase).toContain("items-start");
    expect(errorCase).toContain("numberOfLines={3}");
    expect(errorCase).not.toContain("numberOfLines={1}");

    const heldCase = view.slice(view.indexOf('case "held":'), view.indexOf('case "sending":'));
    expect(heldCase).toContain("items-start");
    expect(heldCase).toContain("numberOfLines={3}");
    expect(heldCase).not.toContain("numberOfLines={1}");
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

/**
 * The footer's WIRING, which no test can actually execute.
 *
 * `app/` has no render environment -- no jsdom, no renderer, and
 * `vitest.config.ts` sets no `environment` -- so nothing can mount this screen
 * and read what the footer shows. Every decision behind it IS covered
 * (`composer-footer.test.ts`, `input-delivery.test.ts`,
 * `send-confirmation.cross-surface.test.ts`), but the half-dozen lines that
 * hand the screen's state to those decisions, and the one line that mounts the
 * result, are reachable only as text.
 *
 * So this is a belt, and it is worth naming what it is: it catches someone
 * accidentally hardwiring an argument or deleting the mount. An adversarial
 * edit that keeps these strings and changes the behaviour passes, which is
 * exactly what happened to the previous version of this file's assertions.
 * The real fix is a render environment; it is queued.
 */
describe("the composer footer is wired to the derived state", () => {
  it("mounts the rendered union", () => {
    expect(agentChatScreenSource()).toContain(
      "<ComposerFooterContentView content={composerFooterStateValue} />",
    );
  });

  it("passes the screen's own values, not constants", () => {
    const source = agentChatScreenSource();
    const callStart = source.indexOf("const composerFooterStateValue = composerFooterState({");
    expect(callStart).toBeGreaterThanOrEqual(0);
    const callEnd = source.indexOf("});", callStart);
    expect(callEnd).toBeGreaterThan(callStart);
    const call = source.slice(callStart, callEnd);

    // The mode and owner-controls flag are what decide whether a transcript
    // pane is on screen. Hardwiring either is how the original bug read as
    // fixed while terminal mode still showed nothing.
    expect(call).toContain("mode: agentOutputViewMode");
    expect(call).toContain("rawOutputAllowed: canUseOwnerControls");
    expect(call).toContain("awaitingEcho: composerSendPendingEcho");
    expect(call).toContain("heldNotice: heldDeliveryNotice");
    expect(call).toContain("error: sendError");
    // Omitted before, so a bare constant here survived.
    expect(call).toContain("sending: sendBusy || composerAwaitingAck");
  });
});
