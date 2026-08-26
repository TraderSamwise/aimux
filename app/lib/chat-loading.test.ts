import { describe, expect, it } from "vitest";

import { paneOutputSnapshotHasVisibleTranscript } from "./chat-loading";

describe("paneOutputSnapshotHasVisibleTranscript", () => {
  it("keeps the initial transcript loader visible for fast empty snapshots", () => {
    expect(
      paneOutputSnapshotHasVisibleTranscript({
        messages: [],
        output: "",
        outputAnsi: "",
      }),
    ).toBe(false);
  });

  it("treats projected messages or terminal bytes as visible transcript content", () => {
    expect(paneOutputSnapshotHasVisibleTranscript({ messages: [{ id: "m1" }] })).toBe(true);
    expect(paneOutputSnapshotHasVisibleTranscript({ messages: [], output: "ready" })).toBe(true);
    expect(
      paneOutputSnapshotHasVisibleTranscript({ messages: [], outputAnsi: "\u001b[32mok" }),
    ).toBe(true);
  });
});
