import { describe, expect, it } from "vitest";

import {
  formatDaemonProjectReadError,
  formatPreviewCaptureUnavailable,
  formatTmuxUnavailable,
  summarizeOperationFailures,
} from "./unavailable-state";

describe("unavailable state formatting", () => {
  it("summarizes operation failures instead of letting them look empty", () => {
    expect(
      summarizeOperationFailures([
        {
          worktreeName: "feature-a",
          target: "feature-a",
          title: "Could not verify tmux windows",
          message: "tmux socket busy",
        },
      ]),
      // The failure's own sentence, not a generic one. The target is carried
      // because this title does not name it -- the CLI card resolves one the
      // same way, so neither surface drops it. `target` is what the project
      // service derives and publishes; the app renders it and walks no chain of
      // its own, so the record here is the published shape rather than the
      // stored one.
    ).toEqual({
      title: "Could not verify tmux windows",
      detail: "feature-a: tmux socket busy",
    });
  });

  it("does not invent a target for a record with nothing to name", () => {
    // Every legacy and store-unavailable record has no worktreeName, targetId
    // or worktreePath. The previous rule asked `title.includes(target)`, and
    // `includes("")` is always true, so this took the right branch for the
    // wrong reason -- and would have printed a bare ": " the moment the rule
    // changed.
    expect(
      summarizeOperationFailures([
        {
          title: "Operation failure store unavailable",
          message: "permission denied",
        },
      ]),
    ).toEqual({
      title: "Operation failure store unavailable",
      detail: "permission denied",
    });
  });

  it("keeps daemon project read errors visible", () => {
    expect(
      formatDaemonProjectReadError({
        projectName: "aimux",
        error: "failed to parse project service endpoint",
      }),
    ).toBe("aimux: failed to parse project service endpoint");
  });

  it("formats tmux unavailable markers from read routes", () => {
    expect(formatTmuxUnavailable({ ok: false, error: "tmux socket busy" })).toBe(
      "tmux socket busy",
    );
  });

  it("formats failed preview capture without marking genuine no-preview", () => {
    expect(
      formatPreviewCaptureUnavailable({
        ok: false,
        error: "tmux capture-pane timed out",
      }),
    ).toBe("Could not read pane: tmux capture-pane timed out");
    expect(formatPreviewCaptureUnavailable(undefined)).toBeNull();
  });
});
