import type { AgentTranscriptMessage, ChatMessage, HistoryPart } from "@/lib/events";

interface ChatMessageOptions {
  shared?: boolean;
}

const LEGACY_SHARED_MESSAGE_RE = /^Message from ([^\n]+?) via Aimux shared chat:\s*([\s\S]*)$/;
const BRACKETED_SHARED_MESSAGE_RE = /^\[[^\]\n]{1,120}\]\s+[\s\S]+$/;

function normalizeSharedText(text: string): string {
  if (BRACKETED_SHARED_MESSAGE_RE.test(text)) return text;
  const match = text.match(LEGACY_SHARED_MESSAGE_RE);
  if (!match) return text;
  const speaker = match[1]?.replace(/\s+/g, " ").trim();
  const body = match[2]?.trim();
  if (!speaker || !body) return text;
  return `[${speaker}] ${body}`;
}

function toHistoryPart(
  part: AgentTranscriptMessage["parts"][number],
  sessionId: string,
  shared: boolean,
): HistoryPart {
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
    parts: message.parts.map(
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
