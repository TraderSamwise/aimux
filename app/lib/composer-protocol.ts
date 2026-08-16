export interface ComposerKeyEventLike {
  key?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

export interface ComposerSendState {
  draft: string;
  hasServiceEndpoint: boolean;
  hasSessionId: boolean;
  sendBusy: boolean;
}

export const COMPOSER_SEND_TIMEOUT_MESSAGE =
  "Send not confirmed after 5s. Check connection and retry.";

export function normalizeComposerDraft(draft: string): string | null {
  const text = draft.trim();
  return text ? text : null;
}

export function shouldSubmitComposerKey(event: ComposerKeyEventLike): boolean {
  return (
    event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
  );
}

export function getComposerSendText(state: ComposerSendState): string | null {
  if (state.sendBusy || !state.hasServiceEndpoint || !state.hasSessionId) return null;
  return normalizeComposerDraft(state.draft);
}

export function formatComposerSendFailure(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : error == null
          ? ""
          : String(error);
  return message ? `Send failed: ${message}` : "Send failed. Check connection and retry.";
}
