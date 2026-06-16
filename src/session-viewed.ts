import { loadConfig } from "./config.js";
import { updateSessionMetadata } from "./metadata-store.js";
import { markNotificationsRead } from "./notifications.js";

export interface MarkSessionViewedResult {
  notificationsRead: number;
  attentionCleared: boolean;
}

function shouldClearAttention(
  attention: string | undefined,
  opts: { clearNeedsInput: boolean; clearFormalInteractions: boolean },
): boolean {
  return (
    (opts.clearNeedsInput && attention === "needs_input") ||
    (opts.clearFormalInteractions && attention === "needs_response")
  );
}

export function markSessionViewed(sessionId: string, projectRoot?: string): MarkSessionViewedResult {
  const notifications = loadConfig({ projectRoot }).notifications;
  const notificationsRead = notifications.markReadOnView ? markNotificationsRead({ sessionId }) : 0;
  let attentionCleared = false;

  updateSessionMetadata(
    sessionId,
    (current) => {
      const derived = current.derived ?? {};
      const clearAttention = shouldClearAttention(derived.attention, {
        clearNeedsInput: notifications.clearNeedsInputOnView,
        clearFormalInteractions: notifications.clearFormalInteractionsOnView,
      });
      attentionCleared = clearAttention;
      return {
        ...current,
        derived: {
          ...derived,
          unseenCount: 0,
          attention: clearAttention ? "normal" : derived.attention,
          // needs_input stores activity:"waiting" alongside the attention. Clearing
          // only the attention leaves "waiting", which reads as "working"; resolve the
          // paired activity so a dismissed agent settles to "ready", not "working".
          activity: clearAttention && derived.activity === "waiting" ? "idle" : derived.activity,
        },
      };
    },
    projectRoot,
  );

  return { notificationsRead, attentionCleared };
}
