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
   * The same inputs the panes are mounted from, passed instead of a
   * `transcriptVisible` boolean: that boolean was the screen's to pass, so it
   * could be hardwired to `true`, which restored the bug this whole change
   * exists to fix with every gate green.
   *
   * It raises the cost of faking rather than removing it -- a reviewer showed
   * `mode: mode === "terminal" ? "chat" : mode` still fakes it at this call
   * site alone. What it buys is that the honest call passes the same bindings
   * the panes use, so the two cannot drift.
   *
   * `width` only maps `split` to `chat`, and both render a transcript, so it
   * does not currently affect this answer. It is passed because
   * `chatOutputPaneVisibility` takes it and the day visibility does depend on
   * width, this follows without being touched.
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
 * How long to keep a held send's notice up, or null if nothing says.
 *
 * Takes the duration the service published rather than an absolute deadline:
 * `maxDeliverAtMs` is the service's own epoch-ms and the client's clock may
 * disagree, which both distorts the countdown and -- for a device far enough
 * behind -- produces a delay `setTimeout` clamps, firing immediately.
 *
 * Clamped at both ends. Below zero a negative delay fires immediately, which
 * is right; above `MAX_HELD_NOTICE_MS` a timer long enough to overflow
 * `setTimeout`'s 32-bit delay also fires immediately, which is the opposite of
 * what a long hold should do.
 *
 * Null means the service gave no duration, so there is nothing to count down
 * and the notice stays until the next send replaces it -- the honest answer
 * for a service that did not say when it would deliver.
 */
export const MAX_HELD_NOTICE_MS = 60_000;

export function heldNoticeDurationMs(input: { holdMs: number | null }): number | null {
  if (input.holdMs === null) return null;
  return Math.min(MAX_HELD_NOTICE_MS, Math.max(0, input.holdMs));
}
