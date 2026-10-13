import { chatOutputPaneVisibility } from "@/lib/chat-output-mode";
import type { AgentOutputViewMode } from "@/stores/settings";

/**
 * What the composer footer says, decided once.
 *
 * This used to be a four-branch ternary in the screen plus a helper that made
 * its own precedence decision twenty lines away, and the two disagreed about
 * where a held send ranked. Worse, the screen's half was reachable only by
 * grepping its own source in a test, so every input to it could be hardwired
 * -- `transcriptVisible: true` restored the bug this whole change exists to
 * fix, with every gate green.
 *
 * So the decision is a value. The footer renders the union and decides
 * nothing; the tests drive this function and reach every branch.
 */

export type ComposerFooterState =
  | { kind: "error"; text: string }
  | { kind: "held"; text: string }
  | { kind: "sending" }
  | { kind: "awaiting-echo"; text: string }
  | { kind: "activity"; label: string; shimmer: boolean }
  | { kind: "empty" };

export const COMPOSER_SEND_AWAITING_ECHO_NOTICE = "Sent — waiting for the agent to show it.";

export interface ComposerFooterStateInput {
  /**
   * The same three the panes are mounted from. Taken instead of a
   * `transcriptVisible` boolean on purpose: that boolean was the screen's to
   * pass, so it could be hardwired to `true` -- which restored the bug this
   * whole change exists to fix, with every gate green. These three cannot be
   * faked without also unmounting the pane the user is looking at.
   */
  mode: AgentOutputViewMode;
  rawOutputAllowed: boolean;
  width: number;
  /** Whatever the send path last failed with. */
  error: string | null;
  /** A send is in flight. */
  sending: boolean;
  /** An accepted send the project service queued rather than delivered. */
  heldNotice: string | null;
  /** A send was accepted and its echo has not come back yet. */
  awaitingEcho: boolean;
  activityLabel: string | null;
  activityLabelShimmer: boolean;
}

export function composerFooterState(input: ComposerFooterStateInput): ComposerFooterState {
  const { chatViewVisible } = chatOutputPaneVisibility({
    mode: input.mode,
    rawOutputAllowed: input.rawOutputAllowed,
    width: input.width,
  });
  // An error is the loudest thing the composer can say.
  if (input.error) return { kind: "error", text: input.error };
  // A held send outranks the in-flight state and shows in EVERY mode: it is
  // not a duplicate of the transcript row, it is the only thing that says the
  // input is queued behind text typed in the agent's own terminal.
  if (input.heldNotice) return { kind: "held", text: input.heldNotice };
  if (input.sending) return { kind: "sending" };
  // A send is confirmed by the message appearing in the transcript. Where
  // there is no transcript on screen -- terminal mode does not mount that
  // pane -- the footer is the only place that can say so.
  if (input.awaitingEcho && !chatViewVisible) {
    return { kind: "awaiting-echo", text: COMPOSER_SEND_AWAITING_ECHO_NOTICE };
  }
  if (input.activityLabel) {
    return { kind: "activity", label: input.activityLabel, shimmer: input.activityLabelShimmer };
  }
  return { kind: "empty" };
}

/**
 * How long until a held send's deadline, or null if there is nothing to wait
 * for.
 *
 * Keyed on the deadline the project service publishes with the hold, not on
 * counting user messages. The count was wrong in exactly the case the notice
 * exists for: the service holds BECAUSE the agent terminal has unsubmitted
 * text, so when the user submits that text it becomes a user message, the
 * count moves, and the notice vanished with our input still queued. Returning
 * from background (a -2000 history window replacing the transcript wholesale)
 * and scrolling up both moved it too.
 *
 * Null means the service gave no deadline, so there is nothing to count down
 * and the notice stays until the next send replaces it -- the honest answer
 * for a service that did not say when it would deliver.
 */
export function heldDeliveryClearDelayMs(input: {
  maxDeliverAtMs: number | null;
  nowMs: number;
}): number | null {
  if (input.maxDeliverAtMs === null) return null;
  return Math.max(0, input.maxDeliverAtMs - input.nowMs);
}
