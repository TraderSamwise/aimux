import type { AgentTranscriptMessage, ChatMessage, HistoryPart } from "@/lib/events";

/**
 * The service's transcript, dressed for this client.
 *
 * Two decisions live here, and both are ours rather than the service's.
 */
export function toChatMessages(
  transcript: readonly AgentTranscriptMessage[],
  sessionId: string,
): ChatMessage[] {
  return transcript.map((message) => ({
    // Keyed by position while it is the newest. Its content changes as the
    // agent writes into it, so a content-derived key would tear the bubble
    // down and build a new one on every poll, mid-read.
    id: message.latest ? `${sessionId}:latest` : message.id,
    role: message.role,
    parts: message.parts.map((part): HistoryPart => {
      if (part.type !== "image_reference") return part;
      return {
        ...part,
        // Built here, not by the service. The same attachment sits at a
        // different address depending on whether we are talking to a local
        // daemon or through the relay, and only this side knows which.
        contentUrl: `/attachments/${part.attachmentId}/content?sessionId=${encodeURIComponent(sessionId)}`,
      };
    }),
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
