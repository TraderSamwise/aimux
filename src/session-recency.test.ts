import { describe, expect, it } from "vitest";
import { sessionRecencyAnchor } from "./session-recency.js";

const OUT = "2026-06-16T00:00:00.000Z";
const IDLE = "2026-06-15T00:00:00.000Z";
const PROMPT = "2026-06-16T00:05:00.000Z";
const USED = "2026-06-10T00:00:00.000Z";

describe("sessionRecencyAnchor", () => {
  it("anchors working/ready to last output", () => {
    expect(sessionRecencyAnchor({ label: "working", lastOutputAt: OUT })).toEqual({ label: "output", value: OUT });
    expect(sessionRecencyAnchor({ label: "ready", lastOutputAt: OUT })).toEqual({ label: "output", value: OUT });
  });

  it("returns null for working/ready with no output yet", () => {
    expect(sessionRecencyAnchor({ label: "working" })).toBeNull();
    expect(sessionRecencyAnchor({ label: "ready" })).toBeNull();
  });

  it("prefers output, else became-idle, for idle/next_step", () => {
    expect(sessionRecencyAnchor({ label: "idle", lastOutputAt: OUT })).toEqual({ label: "output", value: OUT });
    expect(sessionRecencyAnchor({ label: "idle", becameIdleAt: IDLE })).toEqual({ label: "idle", value: IDLE });
    expect(sessionRecencyAnchor({ label: "next_step", becameIdleAt: IDLE })).toEqual({ label: "idle", value: IDLE });
  });

  it("anchors needs_input/needs_response to the prompt time", () => {
    expect(sessionRecencyAnchor({ label: "needs_input", latestUnreadAt: PROMPT, lastOutputAt: OUT })).toEqual({
      label: "prompted",
      value: PROMPT,
    });
    // falls back to output when there's no unread prompt
    expect(sessionRecencyAnchor({ label: "needs_response", lastOutputAt: OUT })).toEqual({
      label: "prompted",
      value: OUT,
    });
  });

  it("labels error as failed and blocked as blocked", () => {
    expect(sessionRecencyAnchor({ label: "error", becameIdleAt: IDLE })).toEqual({ label: "failed", value: IDLE });
    expect(sessionRecencyAnchor({ label: "blocked", lastOutputAt: OUT })).toEqual({ label: "blocked", value: OUT });
  });

  it("anchors offline to last output, else last used", () => {
    expect(sessionRecencyAnchor({ label: "offline", lastUsedAt: USED })).toEqual({ label: "offline", value: USED });
    expect(sessionRecencyAnchor({ label: "offline", lastOutputAt: OUT })).toEqual({ label: "output", value: OUT });
  });
});
