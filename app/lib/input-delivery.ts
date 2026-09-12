import type { LivePaneInputDelivery } from "../../src/project-api-contract";

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
