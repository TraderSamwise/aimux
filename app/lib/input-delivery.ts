import type { LivePaneInputDelivery, LivePaneInputResponse } from "../../src/project-api-contract";

export function formatLivePaneInputDeliveryNotice(
  delivery: LivePaneInputDelivery | undefined,
): string | null {
  if (!delivery) return null;
  if (delivery.state === "delivered") return null;
  const detail = delivery.error || delivery.reason || "delivery did not complete";
  if (delivery.state === "held") return `Input held, not delivered yet: ${detail}`;
  if (delivery.state === "failed") return `Input not delivered: ${detail}`;
  return `Input delivery ${delivery.state}: ${detail}`;
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
