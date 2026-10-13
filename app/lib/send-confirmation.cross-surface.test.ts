import { describe, expect, it } from "vitest";

import { chatOutputPaneVisibility } from "@/lib/chat-output-mode";
import { composerFooterState } from "@/lib/composer-footer";
import { AGENT_OUTPUT_VIEW_MODES } from "@/stores/settings";

/**
 * Every view mode confirms a send somehow.
 *
 * The chat pane confirms it by rendering the message; terminal mode does not
 * mount that pane, so for the one mode where the transcript is absent a send
 * that worked looked exactly like a send that did nothing -- and the
 * ten-second echo timeout then said "Send not confirmed yet" with nothing on
 * screen to explain it.
 *
 * Driven from `AGENT_OUTPUT_VIEW_MODES` and `chatOutputPaneVisibility`, not a
 * list written here. The previous version hardcoded the three modes and
 * asserted its own array had three entries, which could not notice a fourth
 * mode being added -- the exact way the terminal gap survived.
 */

/** Wide enough that `split` is not collapsed back to `chat`. */
const WIDE = 1400;

const QUIET = {
  error: null,
  sending: false,
  heldNotice: null,
  rawOutputAllowed: true,
  width: WIDE,
  activityLabel: null,
  activityLabelShimmer: false,
} as const;

describe("a send is confirmed in every view mode", () => {
  it("covers every mode the app actually offers", () => {
    // Not a length assertion on a local array: this is the list the type is
    // derived from, so a new mode arrives here automatically and the cases
    // below run against it.
    expect([...AGENT_OUTPUT_VIEW_MODES]).toContain("terminal");
    expect(AGENT_OUTPUT_VIEW_MODES.length).toBeGreaterThanOrEqual(3);
  });

  it("shows the message itself, or says so in the composer, never neither", () => {
    for (const mode of AGENT_OUTPUT_VIEW_MODES) {
      const { chatViewVisible } = chatOutputPaneVisibility({
        mode,
        rawOutputAllowed: true,
        width: WIDE,
      });
      const footer = composerFooterState({
        ...QUIET,
        awaitingEcho: true,
        mode,
      });
      const confirmed = chatViewVisible || footer.kind === "awaiting-echo";
      expect(confirmed, `${mode} must confirm an accepted send somehow`).toBe(true);
    }
  });

  it("does not say it twice where the transcript already shows it", () => {
    for (const mode of AGENT_OUTPUT_VIEW_MODES) {
      const { chatViewVisible } = chatOutputPaneVisibility({
        mode,
        rawOutputAllowed: true,
        width: WIDE,
      });
      if (!chatViewVisible) continue;
      expect(
        composerFooterState({ ...QUIET, awaitingEcho: true, mode }).kind,
        `${mode} already renders the sent message`,
      ).not.toBe("awaiting-echo");
    }
  });

  // At least one mode has to hide the transcript, or the case above is
  // vacuous for every mode and this file proves nothing. The previous version
  // leaned on another file's test for this.
  it("has a mode where the transcript is not on screen", () => {
    const hidden = AGENT_OUTPUT_VIEW_MODES.filter(
      (mode) =>
        !chatOutputPaneVisibility({ mode, rawOutputAllowed: true, width: WIDE }).chatViewVisible,
    );
    expect(hidden, "some mode must hide the chat pane, or there is nothing to confirm").not.toEqual(
      [],
    );
  });

  // A share receiver is forced to chat mode, so the transcript is always there
  // and the notice must stay out of a surface that never needed it.
  it("stays out of the read-only surfaces, which are forced to chat", () => {
    for (const mode of AGENT_OUTPUT_VIEW_MODES) {
      const { chatViewVisible } = chatOutputPaneVisibility({
        mode,
        rawOutputAllowed: false,
        width: WIDE,
      });
      expect(chatViewVisible, `${mode} collapses to chat without owner controls`).toBe(true);
      expect(
        composerFooterState({ ...QUIET, awaitingEcho: true, mode, rawOutputAllowed: false }).kind,
      ).not.toBe("awaiting-echo");
    }
  });

  // A held send is the exception: it is not a duplicate of the transcript row,
  // it is the only thing that says the input is queued behind text typed in
  // the agent's own terminal. It has to show in every mode.
  it("shows a held send in every mode, transcript or not", () => {
    for (const mode of AGENT_OUTPUT_VIEW_MODES) {
      expect(
        composerFooterState({
          ...QUIET,
          awaitingEcho: false,
          heldNotice: "Input held: because",
          mode,
        }),
        `${mode} must surface a held send`,
      ).toEqual({ kind: "held", text: "Input held: because" });
    }
  });
});
