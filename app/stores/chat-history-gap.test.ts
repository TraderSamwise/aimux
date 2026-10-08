import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  mergeTranscriptMessages,
  stabilizeSameWindowTranscriptMessages,
  transcriptWindowsAreDisjoint,
} from "@/stores/chat";
import type { AgentTranscriptMessage } from "@/lib/events";

// 947602-98. A capture is a tail of the pane, so after a long background the
// re-requested window shares no message with the stored transcript and the
// lines between were never fetched. Both merge paths used to splice the two
// disjoint lists, which drew a seamless join over that hole.
//
// Line numbers cannot detect this: the echoed `startLine` is the negative
// request, always -160 for the live feed, and `endLine` is never sent for a
// negative request. Shared content is the only available signal.

function message(id: string, text: string): AgentTranscriptMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] } as AgentTranscriptMessage;
}

const BEFORE_SLEEP = [message("a", "before 1"), message("b", "before 2")];
const AFTER_SLEEP = [message("y", "after 1"), message("z", "after 2")];
const OVERLAPPING = [message("b", "before 2"), message("c", "after 1")];

describe("returning from the background", () => {
  it("re-reads the deepest tail rather than the 160-line default", () => {
    // Nothing else can catch this: both merge paths behave correctly with a
    // shallow window, they just have far less to work with, so every
    // assertion above still passes while Sam still loses his history.
    const source = readFileSync(
      join(__dirname, "..", "components", "screens", "AgentChatScreen.tsx"),
      "utf8",
    );
    const at = source.indexOf("const wasAppVisibleRef");
    expect(at, "the resume read must exist").toBeGreaterThan(0);
    const effect = source.slice(at, at + 600);
    expect(effect).toContain("appVisible && !wasAppVisibleRef.current");
    expect(effect).toContain("startLine: CHAT_OUTPUT_MAX_CAPTURE_START_LINE");
    // A deeper start line than the stored one is what takes the wholesale
    // replace branch, so it must not be the live default.
    expect(effect).not.toContain("CHAT_OUTPUT_CAPTURE_START_LINE,");
  });
});

describe("a transcript window that shares nothing with the stored one", () => {
  it("is recognised as a different window, not a continuation", () => {
    expect(transcriptWindowsAreDisjoint(BEFORE_SLEEP, AFTER_SLEEP, 0)).toBe(true);
    // Any shared message means the two abut and the merge is real.
    expect(transcriptWindowsAreDisjoint(BEFORE_SLEEP, OVERLAPPING, 1)).toBe(false);
    // Nothing stored, or nothing arriving, is not a gap.
    expect(transcriptWindowsAreDisjoint([], AFTER_SLEEP, 0)).toBe(false);
    expect(transcriptWindowsAreDisjoint(BEFORE_SLEEP, [], 0)).toBe(false);
  });

  it("is not spliced onto the old one by the paged-back path", () => {
    const merged = mergeTranscriptMessages(BEFORE_SLEEP, AFTER_SLEEP);
    expect(merged).toEqual(AFTER_SLEEP);
    // The join is what made the hole invisible.
    expect(merged.map((m) => m.id)).not.toEqual(["a", "b", "y", "z"]);
  });

  it("is not spliced onto the old one by the same-window path", () => {
    // This is the branch resume actually takes: -160 === -160.
    const merged = stabilizeSameWindowTranscriptMessages(BEFORE_SLEEP, AFTER_SLEEP);
    expect(merged).toEqual(AFTER_SLEEP);
    expect(merged.map((m) => m.id)).not.toEqual(["a", "b", "y", "z"]);
  });

  it("still merges a window that genuinely abuts", () => {
    const merged = mergeTranscriptMessages(BEFORE_SLEEP, OVERLAPPING);
    // `b` is shared, so the result keeps `a` and continues through it.
    expect(merged.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });
});
