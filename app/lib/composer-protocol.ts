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

export interface ComposerAckMessageLike {
  parts?: readonly { filename?: string; label?: string; text?: string; type?: string }[];
  role?: string;
  text?: string | null;
}

export interface PendingComposerAckLike {
  attachmentFilenames: readonly string[];
  baselineUserMessageCount: number;
  text: string;
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

export function normalizeComposerAckText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function composerAckMessageText(message: ComposerAckMessageLike): string {
  const textParts =
    message.parts
      ?.flatMap((part) => [part.text, part.filename, part.label])
      .filter((value): value is string => typeof value === "string" && value.length > 0) ?? [];
  return normalizeComposerAckText([message.text ?? "", ...textParts].filter(Boolean).join(" "));
}

export function userMessageAcknowledgesComposerSend(
  messages: readonly ComposerAckMessageLike[],
  pending: PendingComposerAckLike,
): boolean {
  const userMessages = messages.filter((message) => message.role === "user");
  if (userMessages.length <= pending.baselineUserMessageCount) return false;
  const sentText = normalizeComposerAckText(pending.text);
  const newMessages = userMessages.slice(pending.baselineUserMessageCount);
  return newMessages.some((message) => {
    const messageText = composerAckMessageText(message);
    if (sentText && messageText.includes(sentText)) return true;
    if (pending.attachmentFilenames.length === 0) return false;
    return pending.attachmentFilenames.every((filename) => messageText.includes(filename));
  });
}
