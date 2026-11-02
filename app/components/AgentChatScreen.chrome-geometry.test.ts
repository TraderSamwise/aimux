import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourcePath = join(dirname(fileURLToPath(import.meta.url)), "screens/AgentChatScreen.tsx");

function screenSource(): string {
  return readFileSync(sourcePath, "utf8");
}

/**
 * The gap between the header and the panel under it was a constant standing
 * in for a rendered height. Arithmetic tests cannot catch that -- they agree
 * with whatever number they are given -- so what is pinned here is that the
 * offsets are built from a MEASUREMENT, and that each measured row actually
 * measures itself.
 */
describe("chat chrome geometry", () => {
  it("positions the panels from measured rows, not from the guesses", () => {
    const source = screenSource();
    expect(source).toContain(
      "topBarHeight + chatChromeRowHeight(sessionHeaderHeight, CHAT_SESSION_HEADER_HEIGHT)",
    );
    expect(source).toContain(
      "chatChromeRowHeight(reconnectingPanelHeight, CHAT_RECONNECTING_PANEL_RESERVE)",
    );
  });

  it("measures every row it positions from", () => {
    const source = screenSource();
    // Inside an `onLayout`, not merely present. A reserve built from state
    // nothing ever sets is the same bug wearing a different name -- it would
    // sit on its fallback for ever -- and a setter moved into a callback
    // nothing calls leaves the string right here, passing.
    for (const setter of ["setSessionHeaderHeight", "setReconnectingPanelHeight"]) {
      const at = source.indexOf(`${setter}((current)`);
      expect(at, `${setter} must exist`).toBeGreaterThanOrEqual(0);
      expect(
        source.slice(Math.max(0, at - 220), at),
        `${setter} must be wired to an onLayout`,
      ).toContain("onLayout={");
    }
  });

  it("gives the transcript the same header height as the panels", () => {
    // The miss this catches is mine: the panel offsets took the measurement
    // and the transcript's own top padding kept the constant, so the two
    // disagreed by exactly the pixels this change is about.
    // Matched without pinning prettier's indentation: a reformat, or one more
    // argument, should not fail a geometry gate.
    expect(screenSource()).toMatch(
      /chatTranscriptTopReserveHeight\(\{[^}]*\bsessionHeaderHeight\b[^}]*\}\)/s,
    );
    expect(screenSource()).toMatch(
      /chatOverlayPanelReserveHeight\(\{[^}]*\breconnectingPanelHeight\b[^}]*\}\)/s,
    );
  });

  it("does not add a bare constant back into the offsets", () => {
    const source = screenSource();
    expect(source).not.toContain("topBarHeight + CHAT_SESSION_HEADER_HEIGHT");
    expect(source).not.toContain("? CHAT_RECONNECTING_PANEL_RESERVE : 0");
  });
});
