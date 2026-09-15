import type { LivePaneInputDelivery, LivePaneInputResponse } from "../../src/project-api-contract";

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

function formatLivePaneInputDeliveryReason(reason: string | undefined): string | undefined {
  switch (reason) {
    case "visible-unsubmitted-input":
      return "the agent terminal already has typed text. Clear or send that terminal draft, or Aimux will send this after the 15s safety hold.";
    case "active-client-recent-input":
      return "a tmux client typed in the agent terminal recently. Aimux will retry after the terminal is quiet for a moment.";
    case "max-hold-elapsed":
      return "the 15s safety hold elapsed, so Aimux is sending the queued input now.";
    default:
      return reason;
  }
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
