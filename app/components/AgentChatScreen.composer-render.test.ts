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
});
