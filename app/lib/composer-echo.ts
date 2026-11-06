import type { ChatMessage } from "@/lib/events";

export interface AcceptedComposerEcho {
  baselineMessageCount: number;
  baselineUserMessageCount: number;
  clientMessageId: string;
  createdAtMs: number;
  message: ChatMessage;
  settled?: boolean;
  /// Whether this send should ever appear in the PARSED transcript.
  ///
  /// False for a command: the agent consumes it and need not write a user
  /// turn, so its echo expiring says nothing about delivery. The echo is
  /// still queued -- it is what draws the bubble and the awaiting-echo footer
  /// -- it just does not become "Send not confirmed yet" when it times out.
  expectsTranscriptEcho?: boolean;
}

export interface ComposerEchoMergeResult {
  messages: ChatMessage[];
  echoes: AcceptedComposerEcho[];
  droppedUnconfirmedCount: number;
  droppedExpiredCount: number;
  droppedTranscriptAdvancedCount: number;
}

export const COMPOSER_ECHO_CONFIRMATION_TIMEOUT_MS = 10_000;

function mergeConfirmedMessage(parsed: ChatMessage, accepted: AcceptedComposerEcho): ChatMessage {
  return {
    ...parsed,
    clientMessageId: accepted.clientMessageId,
  };
}

function confirmationSlotIndex(
  parsedMessages: readonly ChatMessage[],
  accepted: AcceptedComposerEcho,
  claimedParsedIndexes: ReadonlySet<number>,
): number {
  let userIndex = -1;
  for (let index = 0; index < parsedMessages.length; index += 1) {
    const message = parsedMessages[index];
    if (message?.role !== "user") continue;
    userIndex += 1;
    if (userIndex < accepted.baselineUserMessageCount) continue;
    if (claimedParsedIndexes.has(index)) continue;
    return index;
  }
  return -1;
}

/**
 * Whether two echo lists hold the same echoes.
 *
 * `mergeAcceptedComposerEchoes` always allocates a fresh `echoes` array, so a
 * reference check against its input is ALWAYS unequal. An effect that both
 * depends on the echo state and writes it back on reference inequality
 * therefore never settles: set state, re-render, merge, new array, set state.
 * That is an infinite render loop, and it hung the app suite.
 *
 * Element identity is the right grain. The merge reuses an echo object when
 * nothing about it changed and allocates a new one only when it actually
 * transitions, so comparing element by element reaches a fixed point after at
 * most one write.
 */
export function sameAcceptedComposerEchoes(
  left: readonly AcceptedComposerEcho[],
  right: readonly AcceptedComposerEcho[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((echo, index) => echo === right[index]);
}

export function mergeAcceptedComposerEchoes(
  parsedMessages: readonly ChatMessage[],
  acceptedEchoes: readonly AcceptedComposerEcho[],
  options: {
    nowMs: number;
    timeoutMs?: number;
  },
): ComposerEchoMergeResult {
  if (acceptedEchoes.length === 0) {
    return {
      messages: [...parsedMessages],
      echoes: [],
      droppedExpiredCount: 0,
      droppedTranscriptAdvancedCount: 0,
      droppedUnconfirmedCount: 0,
    };
  }

  const timeoutMs = options.timeoutMs ?? COMPOSER_ECHO_CONFIRMATION_TIMEOUT_MS;
  const claimedParsedIndexes = new Set<number>();
  const replacements = new Map<number, ChatMessage>();
  const retainedEchoes: AcceptedComposerEcho[] = [];
  const pendingEchoes: AcceptedComposerEcho[] = [];
  let droppedUnconfirmedCount = 0;
  let droppedExpiredCount = 0;
  let droppedTranscriptAdvancedCount = 0;

  for (const accepted of acceptedEchoes) {
    const matchIndex = confirmationSlotIndex(parsedMessages, accepted, claimedParsedIndexes);
    if (matchIndex >= 0) {
      claimedParsedIndexes.add(matchIndex);
      replacements.set(matchIndex, mergeConfirmedMessage(parsedMessages[matchIndex]!, accepted));
      retainedEchoes.push(accepted.settled ? accepted : { ...accepted, settled: true });
      continue;
    }

    const transcriptAdvanced = parsedMessages.length > accepted.baselineMessageCount;
    const expired = options.nowMs - accepted.createdAtMs >= timeoutMs;
    if (accepted.settled || transcriptAdvanced || expired) {
      droppedUnconfirmedCount += 1;
      if (transcriptAdvanced) {
        droppedTranscriptAdvancedCount += 1;
      } else if (expired && accepted.expectsTranscriptEcho !== false) {
        // A command's echo expiring is the expected ending, not a failure.
        droppedExpiredCount += 1;
      }
      continue;
    }

    retainedEchoes.push(accepted);
    pendingEchoes.push(accepted);
  }

  const messages = parsedMessages.map((message, index) => replacements.get(index) ?? message);
  let inserted = 0;
  for (const accepted of pendingEchoes) {
    const insertAt = Math.min(accepted.baselineMessageCount + inserted, messages.length);
    messages.splice(insertAt, 0, accepted.message);
    inserted += 1;
  }

  return {
    messages,
    echoes: retainedEchoes,
    droppedExpiredCount,
    droppedTranscriptAdvancedCount,
    droppedUnconfirmedCount,
  };
}
