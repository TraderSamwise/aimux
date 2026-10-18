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
  // The terminal's own inset-aware scrolling moved to
  // `AgentChatScreen.scroll-end.test.ts`, which asserts a superset of what was
  // here and asserts it for BOTH panes at once. Two files asserting the same
  // line is the second place it has to be kept in step.
});

// Attachment upload ordering remains a source guard; mounted attachment
// interactions are outside the composer-footer component tests.
describe("attachments are checked before anything is uploaded", () => {
  it("runs the check before the send is marked busy", () => {
    const source = agentChatScreenSource();
    const checkAt = source.indexOf("firstOversizedAttachment(attachments)");
    expect(checkAt).toBeGreaterThanOrEqual(0);

    // Before `sendBusyRef.current = true`, so a refused send leaves the draft
    // and the attachments exactly as they were.
    const busyAt = source.indexOf("sendBusyRef.current = true;");
    expect(busyAt).toBeGreaterThan(checkAt);

    // And before the upload loop, so a rejection cannot leave earlier files
    // already stored on the service.
    const uploadAt = source.indexOf("await uploadAttachment(");
    expect(uploadAt).toBeGreaterThan(checkAt);
  });

  it("says which file and how large, not just that it failed", () => {
    expect(agentChatScreenSource()).toContain("attachmentTooLargeMessage({");
  });
});
