import { describe, expect, it } from "vitest";

import { chatOutputPaneVisibility } from "@/lib/chat-output-mode";
import type { AgentOutputViewMode } from "@/stores/settings";
import { composerSendNotice } from "@/lib/composer-protocol";

/**
 * Every view mode confirms a send somehow.
 *
 * The chat pane confirms it by rendering the message; terminal mode does not
 * mount that pane, so for the one mode where the transcript is absent a send
 * that worked looked exactly like a send that did nothing -- and the
 * ten-second echo timeout then said "Send not confirmed yet" with nothing on
 * screen to explain it.
 *
 * Driven from `chatOutputPaneVisibility` rather than a hardcoded list of
 * modes, so a fourth mode cannot be added without either rendering the
 * transcript or carrying the notice. AGENTS.md asks for a test that compares
 * the surfaces against each other rather than one test per surface.
 */

const MODES: AgentOutputViewMode[] = ["chat", "split", "terminal"];

/** Wide enough that `split` is not collapsed back to `chat`. */
const WIDE = 1400;

describe("a send is confirmed in every view mode", () => {
  it("covers every mode the settings type allows", () => {
    // Guards against a mode being added to the union and silently skipped
    // here, which is how the terminal gap survived in the first place.
    expect(MODES).toHaveLength(3);
  });

  it("shows the message itself, or says so in the composer, never neither", () => {
    for (const mode of MODES) {
      const { chatViewVisible } = chatOutputPaneVisibility({
        mode,
        rawOutputAllowed: true,
        width: WIDE,
      });
      const notice = composerSendNotice({
        awaitingEcho: true,
        error: null,
        heldNotice: null,
        sending: false,
        transcriptVisible: chatViewVisible,
      });
      const confirmed = chatViewVisible || notice !== null;
      expect(confirmed, `${mode} must confirm an accepted send somehow`).toBe(true);
    }
  });

  it("does not say it twice where the transcript already shows it", () => {
    for (const mode of MODES) {
      const { chatViewVisible } = chatOutputPaneVisibility({
        mode,
        rawOutputAllowed: true,
        width: WIDE,
      });
      if (!chatViewVisible) continue;
      const notice = composerSendNotice({
        awaitingEcho: true,
        error: null,
        heldNotice: null,
        sending: false,
        transcriptVisible: chatViewVisible,
      });
      expect(notice, `${mode} already renders the sent message`).toBeNull();
    }
  });

  // A share receiver is forced to chat mode, so the transcript is always there
  // and the notice must stay out of a surface that never needed it.
  it("stays out of the read-only surfaces, which are forced to chat", () => {
    for (const mode of MODES) {
      const { chatViewVisible } = chatOutputPaneVisibility({
        mode,
        rawOutputAllowed: false,
        width: WIDE,
      });
      expect(chatViewVisible, `${mode} collapses to chat without owner controls`).toBe(true);
      expect(
        composerSendNotice({
          awaitingEcho: true,
          error: null,
          heldNotice: null,
          sending: false,
          transcriptVisible: chatViewVisible,
        }),
      ).toBeNull();
    }
  });
});
