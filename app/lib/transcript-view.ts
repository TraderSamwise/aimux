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
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("audio/")) return "audio";
  if (normalized.startsWith("video/")) return "video";
  if (normalized === "application/pdf") return "pdf";
  if (normalized.startsWith("text/") || normalized === "application/json") return "text";
  return "file";
}

function filenameLooksLikeImage(filename?: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|heic|heif|bmp|tiff?)$/i.test(filename?.trim() ?? "");
}

function partLooksLikeImage(part: HistoryAttachmentReferencePart): boolean {
  return (
    part.kind === "image" ||
    part.mimeType?.toLowerCase().startsWith("image/") === true ||
    filenameLooksLikeImage(part.filename)
  );
}

function normalizeAttachmentReferencePart(part: HistoryPart): HistoryPart {
  if (part.type !== "attachment_reference" || !partLooksLikeImage(part)) return part;
  return {
    type: "image_reference",
    label: part.label.replace(/^\[file\b/i, "[image"),
    attachmentId: part.attachmentId,
    filename: part.filename,
    mimeType: part.mimeType,
    contentUrl: part.contentUrl,
    hostedContentUrl: part.hostedContentUrl,
    hostedExpiresAt: part.hostedExpiresAt,
  };
}

function legacyAttachmentPart(
  attachmentId: string,
  opts: { filename?: string; mimeType?: string },
  labels: { image: number; file: number },
): HistoryPart {
  if (attachmentKindForMimeType(opts.mimeType) === "image") {
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
  const imageHeader = /\bAttached image files:\s*/i.test(text);
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

  if (!matched) {
    const recovered = recoverWrappedLegacyAttachments(tail, labels, imageHeader);
    if (!recovered) return null;
    const { parts: recoveredParts, prose } = recovered;
    if (prose) parts.push({ type: "text", text: prose });
    parts.push(...recoveredParts);
    return parts;
  }

  const suffix = tail.slice(cursor).trim();
  if (suffix) parts.push({ type: "text", text: suffix });
  return parts;
}

function recoverWrappedLegacyAttachments(
  tail: string,
  labels: { image: number; file: number },
  imageHeader: boolean,
): { parts: HistoryPart[]; prose: string } | null {
  let squashed = "";
  const sourceIndex: number[] = [];
  for (let index = 0; index < tail.length; index += 1) {
    if (/\s/.test(tail[index]!)) continue;
    squashed += tail[index];
    sourceIndex.push(index);
  }

  const parts: HistoryPart[] = [];
  const drop = new Set<number>();

  for (const match of squashed.matchAll(
    /\.aimux\/attachments\/(att_[A-Za-z0-9_-]+)(?:\.([A-Za-z0-9]{1,8}))?/g,
  )) {
    if (!match[1] || match.index === undefined) continue;
    let from = match.index;
    while (from > 0 && !/[-•]/.test(squashed[from - 1]!)) from -= 1;
    if (from > 0) from -= 1;
    const item = squashed.slice(from, match.index + match[0].length);
    const itemMatch = item.match(
      /^[-•]?(.+?)\(([A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+),\d+bytes\):/,
    );
    const mimeType = itemMatch?.[2] ?? (imageHeader ? "image/unknown" : undefined);
    parts.push(
      legacyAttachmentPart(
        match[1],
        {
          filename: itemMatch?.[1],
          mimeType,
        },
        labels,
      ),
    );
    for (let index = from; index < match.index + match[0].length; index += 1) {
      drop.add(sourceIndex[index]!);
    }
  }

  if (parts.length === 0) return null;

  const prose = tail
    .split("")
    .filter((_, index) => !drop.has(index))
    .join("")
    .replace(/[-•]\s*(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { parts, prose };
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
    // Built here only when the service did not provide a durable hosted URL.
    contentUrl:
      part.contentUrl ??
      `/attachments/${part.attachmentId}/content?sessionId=${encodeURIComponent(sessionId)}`,
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
    parts: normalizeLegacyAttachmentParts(message.parts)
      .map(normalizeAttachmentReferencePart)
      .map(
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
