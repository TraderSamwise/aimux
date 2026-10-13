import type { LivePaneInputDelivery, LivePaneInputResponse } from "../../src/project-api-contract";

/**
 * Whether a delivery notice describes a failure or a wait.
 *
 * `held` comes back with `accepted: true` -- the input is queued and the
 * project service will deliver it within the 15s safety hold. Routing it to
 * the same red error line as `failed` told the user their send had not worked
 * when it had, which is the wrapper lying about a child outcome.
 */
export type LivePaneInputDeliveryOutcome = "delivered" | "pending" | "failed";

export function livePaneInputDeliveryOutcome(
  delivery: LivePaneInputDelivery | undefined,
): LivePaneInputDeliveryOutcome {
  if (!delivery || delivery.state === "delivered") return "delivered";
  return delivery.state === "held" ? "pending" : "failed";
}

export function formatLivePaneInputDeliveryNotice(
  delivery: LivePaneInputDelivery | undefined,
): string | null {
  if (!delivery) return null;
  if (delivery.state === "delivered") return null;
  const detail =
    delivery.error ||
    formatLivePaneInputDeliveryReason(delivery.reason) ||
    "delivery did not complete";
  if (delivery.state === "held") return `Input held, not delivered yet: ${detail}`;
  if (delivery.state === "failed") return `Input not delivered: ${detail}`;
  return `Input delivery ${delivery.state}: ${detail}`;
}

/**
 * The reasons a delivery is HELD, in the words the user reads.
 *
 * These have to be the strings `decide_agent_input_delivery` actually puts on
 * a `Hold` -- the two below. They were keyed on `visible-unsubmitted-input`
 * and `max-hold-elapsed`, neither of which the service emits, so the branch
 * that tells the user what to do was dead and the notice rendered the raw
 * slug: "Input held, not delivered yet: visible-unsubmitted-input-recent-user-input".
 * `input-delivery-reasons.cross-surface.test.ts` reads the Rust source and
 * fails if a held reason has no wording here.
 */
function formatLivePaneInputDeliveryReason(reason: string | undefined): string | undefined {
  switch (reason) {
    case "visible-unsubmitted-input-recent-user-input":
      return "the agent terminal already has typed text. Clear or send that terminal draft, or Aimux will send this after the 15s safety hold.";
    case "active-client-recent-input":
      return "a tmux client typed in the agent terminal recently. Aimux will retry after the terminal is quiet for a moment.";
    default:
      // A reason with spaces is prose the service wrote for a person, so it
      // passes through. A bare slug is an internal enum and is not a
      // sentence: rendering it gave the user
      // "Input held, not delivered yet: visible-unsubmitted-input-recent-user-input".
      if (!reason) return undefined;
      return reason.includes(" ")
        ? reason
        : "Aimux will retry shortly; the agent terminal was busy.";
  }
}

/**
 * What a send response means for the composer, as one value.
 *
 * The screen used to make this call inline with
 * `livePaneInputDeliveryOutcome(...) === "pending" ? setHeld : setError`, and
 * nothing could reach that expression -- flipping it to `=== "failed"` put an
 * accepted send back on the red error line with every test green.
 */
export type SendDeliveryState =
  | { kind: "none" }
  | { kind: "held"; notice: string; maxDeliverAtMs: number | null }
  | { kind: "error"; text: string };

export function sendDeliveryStateAfterResponse(
  response: Pick<LivePaneInputResponse, "delivery">,
): SendDeliveryState {
  const notice = formatLivePaneInputDeliveryNotice(response.delivery);
  if (!notice) return { kind: "none" };
  if (livePaneInputDeliveryOutcome(response.delivery) !== "pending") {
    return { kind: "error", text: notice };
  }
  const deadline = response.delivery?.maxDeliverAtMs;
  return {
    kind: "held",
    notice,
    maxDeliverAtMs: typeof deadline === "number" && Number.isFinite(deadline) ? deadline : null,
  };
}

export function formatLivePaneInputResponseRefusal(response: LivePaneInputResponse): string | null {
  if (response.accepted) return null;
  const detail =
    response.error ||
    response.message ||
    response.delivery?.error ||
    response.delivery?.reason ||
    "input was not accepted";
  return `Input not accepted: ${detail}`;
}

export function formatPostActionTranscriptRefreshFailure(action: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${action}, but transcript refresh failed: ${detail}`;
}

export function formatPostActionTranscriptRefreshResult(
  action: string,
  error: unknown | null | undefined,
): string | null {
  if (error == null) return null;
  return formatPostActionTranscriptRefreshFailure(action, error);
}
