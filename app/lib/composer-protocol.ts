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
  parts?: readonly {
    attachmentId?: string;
    filename?: string;
    label?: string;
    text?: string;
    type?: string;
  }[];
  role?: string;
  text?: string | null;
}

export interface PendingComposerAckLike {
  attachmentCount?: number;
  attachmentIds?: readonly string[];
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
      ?.flatMap((part) => [part.text, part.filename, part.label, part.attachmentId])
      .filter((value): value is string => typeof value === "string" && value.length > 0) ?? [];
  return normalizeComposerAckText([message.text ?? "", ...textParts].filter(Boolean).join(" "));
}

function messageAttachmentPartCount(message: ComposerAckMessageLike): number {
  return (
    message.parts?.filter(
      (part) =>
        part.type === "image_reference" ||
        part.type === "attachment_reference" ||
        Boolean(part.attachmentId || part.filename),
    ).length ?? 0
  );
}

function messageAttachmentTokens(message: ComposerAckMessageLike): Set<string> {
  const tokens = new Set<string>();
  for (const part of message.parts ?? []) {
    if (
      part.type !== "image_reference" &&
      part.type !== "attachment_reference" &&
      !part.attachmentId &&
      !part.filename
    ) {
      continue;
    }
    for (const token of [part.attachmentId, part.filename]) {
      const normalized = typeof token === "string" ? normalizeComposerAckText(token) : "";
      if (normalized) tokens.add(normalized);
    }
  }
  return tokens;
}

function messageAcknowledgesAttachments(
  message: ComposerAckMessageLike,
  pending: PendingComposerAckLike,
): boolean {
  const attachmentIds = pending.attachmentIds ?? [];
  const pendingAttachmentCount = Math.max(
    pending.attachmentCount ?? 0,
    attachmentIds.length,
    pending.attachmentFilenames.length,
  );
  if (pendingAttachmentCount === 0) return true;

  const messageTokens = messageAttachmentTokens(message);
  const pendingTokenGroups = Array.from({ length: pendingAttachmentCount }, (_, index) =>
    [attachmentIds[index], pending.attachmentFilenames[index]]
      .map((token) => (typeof token === "string" ? normalizeComposerAckText(token) : ""))
      .filter(Boolean),
  );
  if (messageTokens.size > 0 || pendingTokenGroups.some((tokens) => tokens.length > 0)) {
    return pendingTokenGroups.every(
      (tokens) => tokens.length > 0 && tokens.some((token) => messageTokens.has(token)),
    );
  }

  return messageAttachmentPartCount(message) >= pendingAttachmentCount;
}

export function userMessageAcknowledgesComposerSend(
  messages: readonly ComposerAckMessageLike[],
  pending: PendingComposerAckLike,
): boolean {
  const userMessages = messages.filter((message) => message.role === "user");
  if (userMessages.length <= pending.baselineUserMessageCount) return false;
  const sentText = normalizeComposerAckText(pending.text);
  const hasPendingAttachments =
    (pending.attachmentCount ?? 0) > 0 ||
    (pending.attachmentIds?.length ?? 0) > 0 ||
    pending.attachmentFilenames.length > 0;
  const newMessages = userMessages.slice(pending.baselineUserMessageCount);
  return newMessages.some((message) => {
    const messageText = composerAckMessageText(message);
    const textMatches = !sentText || messageText.includes(sentText);
    if (!textMatches) return false;
    if (!hasPendingAttachments) return Boolean(sentText);
    return messageAcknowledgesAttachments(message, pending);
  });
}
