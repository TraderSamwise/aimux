import { describe, expect, it } from "vitest";

import { unreadBadgeLabel } from "./unread-badge";

/**
 * The strings here are the same ones `agent_unread_across_surfaces.rs` asserts
 * for the TUI badge and `compactHint`. A cap rule cannot be shared across the
 * language boundary, so the two sides are pinned to one set of literals
 * instead: if either moves, one of these two files fails.
 */
describe("how an unread count is written", () => {
  it("draws nothing when there is nothing unread", () => {
    expect(unreadBadgeLabel(0)).toBeNull();
    expect(unreadBadgeLabel(undefined)).toBeNull();
    // A negative count is a bug upstream, not a badge.
    expect(unreadBadgeLabel(-3)).toBeNull();
  });

  it("writes the count up to the cap", () => {
    expect(unreadBadgeLabel(1)).toBe("1");
    expect(unreadBadgeLabel(7)).toBe("7");
    // The boundary, which is what a threshold moved anywhere below 100 would
    // break. 99 is not capped.
    expect(unreadBadgeLabel(99)).toBe("99");
  });

  it("marks the cap rather than claiming the capped number", () => {
    expect(unreadBadgeLabel(100)).toBe("99+");
    expect(unreadBadgeLabel(150)).toBe("99+");
  });
});
