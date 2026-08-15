import type {
  AgentTranscriptMessage,
  ChatMessage,
  HistoryAttachmentReferencePart,
  HistoryPart,
} from "@/lib/events";

interface ChatMessageOptions {
  shared?: boolean;
}

const LEGACY_SHARED_MESSAGE_RE = /^Message from ([^\n]+?) via Aimux shared chat:\s*([\s\S]*)$/;
const BRACKETED_SHARED_MESSAGE_RE = /^\[[^\]\n]{1,120}\]\s+[\s\S]+$/;
const ATTACHMENT_MIME_PATTERN = "[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+";
const LEGACY_ATTACHMENTS_HEADER = /\bAttached (?:image )?files:\s*/i;
const LEGACY_ATTACHMENT_ITEM = new RegExp(
  `-\\s+(.+?)\\s+\\((${ATTACHMENT_MIME_PATTERN}),\\s+\\d+\\s+bytes\\):\\s+(\\S*?\\.aimux\\/attachments\\/(att_[A-Za-z0-9_-]+)\\.[^\\s/]+)`,
  "g",
);

function normalizeSharedText(text: string): string {
  if (BRACKETED_SHARED_MESSAGE_RE.test(text)) return text;
  const match = text.match(LEGACY_SHARED_MESSAGE_RE);
  if (!match) return text;
  const speaker = match[1]?.replace(/\s+/g, " ").trim();
  const body = match[2]?.trim();
  if (!speaker || !body) return text;
  return `[${speaker}] ${body}`;
}

function attachmentKindForMimeType(mimeType?: string): HistoryAttachmentReferencePart["kind"] {
  const normalized = mimeType?.toLowerCase() ?? "";
  if (normalized.startsWith("audio/")) return "audio";
  if (normalized.startsWith("video/")) return "video";
  if (normalized === "application/pdf") return "pdf";
  if (normalized.startsWith("text/") || normalized === "application/json") return "text";
  return "file";
}

function legacyAttachmentPart(
  attachmentId: string,
  opts: { filename?: string; mimeType?: string },
  labels: { image: number; file: number },
): HistoryPart {
  if ((opts.mimeType ?? "").toLowerCase().startsWith("image/")) {
    return {
      type: "image_reference",
      label: `[image #${labels.image++}]`,
      attachmentId,
      filename: opts.filename,
      mimeType: opts.mimeType,
    };
  }
  return {
    type: "attachment_reference",
    label: `[file #${labels.file++}]`,
    attachmentId,
    filename: opts.filename,
    mimeType: opts.mimeType,
    kind: attachmentKindForMimeType(opts.mimeType),
  };
}

function partsFromLegacyAttachmentText(
  text: string,
  labels: { image: number; file: number },
): HistoryPart[] | null {
  if (!LEGACY_ATTACHMENTS_HEADER.test(text)) return null;

  const flattened = text.replace(/\s+/g, " ").trim();
  const header = flattened.match(LEGACY_ATTACHMENTS_HEADER);
  if (header?.index === undefined) return null;

  const parts: HistoryPart[] = [];
  const head = flattened.slice(0, header.index).trim();
  const tail = flattened.slice(header.index + header[0].length);
  if (head) parts.push({ type: "text", text: head });

  let cursor = 0;
  let matched = false;
  LEGACY_ATTACHMENT_ITEM.lastIndex = 0;
  for (const match of tail.matchAll(LEGACY_ATTACHMENT_ITEM)) {
    if (!match[4] || match.index === undefined) continue;
    const between = tail.slice(cursor, match.index).trim();
    if (between) parts.push({ type: "text", text: between });
    parts.push(legacyAttachmentPart(match[4], { filename: match[1], mimeType: match[2] }, labels));
    cursor = match.index + match[0].length;
    matched = true;
  }

  if (!matched) return null;

  const suffix = tail.slice(cursor).trim();
  if (suffix) parts.push({ type: "text", text: suffix });
  return parts;
}

function normalizeLegacyAttachmentParts(
  parts: readonly AgentTranscriptMessage["parts"][number][],
): HistoryPart[] {
  const labels = { image: 1, file: 1 };
  return parts.flatMap((part): HistoryPart[] => {
    if (part.type !== "text") return [part];
    const legacyParts = partsFromLegacyAttachmentText(part.text, labels);
    return legacyParts ?? [part];
  });
}

function toHistoryPart(part: HistoryPart, sessionId: string, shared: boolean): HistoryPart {
  if (part.type === "text") {
    const text = shared ? normalizeSharedText(part.text) : part.text;
    if (text === part.text) return part;
    return { type: "text", text };
  }
  if (part.type !== "image_reference" && part.type !== "attachment_reference") return part;
  return {
    ...part,
    // Built here, not by the service. The same attachment sits at a
    // different address depending on whether we are talking to a local
    // daemon or through the relay, and only this side knows which.
    contentUrl: `/attachments/${part.attachmentId}/content?sessionId=${encodeURIComponent(sessionId)}`,
  };
}

/**
 * The service's transcript, dressed for this client.
 *
 * Two decisions live here, and both are ours rather than the service's.
 */
export function toChatMessages(
  transcript: readonly AgentTranscriptMessage[],
  sessionId: string,
  options: ChatMessageOptions = {},
): ChatMessage[] {
  const shared = options.shared === true;
  return transcript.map((message) => ({
    // Keyed by position while it is the newest. Its content changes as the
    // agent writes into it, so a content-derived key would tear the bubble
    // down and build a new one on every poll, mid-read.
    id: message.latest ? `${sessionId}:latest` : message.id,
    role: message.role,
    parts: normalizeLegacyAttachmentParts(message.parts).map(
      (part): HistoryPart => toHistoryPart(part, sessionId, shared && message.role === "user"),
    ),
  }));
}

/**
 * Whether the service is old enough not to know about `messages` at all.
 *
 * `undefined` and `[]` are different answers: one is "I do not project the
 * transcript", the other is "there is nothing in this pane". Collapsing them
 * renders a permanently blank chat against an older daemon and calls it empty.
 */
export function serviceProjectsTranscript(messages: unknown): boolean {
  return Array.isArray(messages);
}
