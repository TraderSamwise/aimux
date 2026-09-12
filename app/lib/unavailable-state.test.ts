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
          title: "Could not verify tmux windows",
          message: "tmux socket busy",
        },
      ]),
    ).toEqual({
      title: "Project state has an operation failure",
      detail: "feature-a: Could not verify tmux windows: tmux socket busy",
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
